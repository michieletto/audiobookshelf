const { expect } = require('chai')
const { Sequelize } = require('sequelize')

const Database = require('../../../../server/Database')
const libraryFilters = require('../../../../server/utils/queries/libraryFilters')

const audioFile = (n, size = 100, extra = {}) => ({ index: n, ino: `${n}`, duration: 60, metadata: { filename: `${n}.mp3`, ext: '.mp3', path: `/b/${n}.mp3`, relPath: `${n}.mp3`, size }, ...extra })
const b64 = (v) => encodeURIComponent(Buffer.from(v).toString('base64'))

describe('library listing queries do not load the audio files', () => {
  let library
  let user
  const itemIds = {}

  const listing = (opts = {}) =>
    Database.libraryItemModel.getByFilterAndSort(library, user, { sortBy: 'media.metadata.title', sortDesc: false, limit: 50, offset: 0, include: [], mediaType: 'book', collapseseries: false, ...opts })

  beforeEach(async () => {
    global.ServerSettings = { sortingIgnorePrefix: false }
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book', settings: { hideSingleBookSeries: false } })
    const folder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })
    user = { id: 'user-1', canAccessExplicitContent: true, isAdminOrUp: true, permissions: { accessAllTags: true } }

    const series = await Database.seriesModel.create({ name: 'The Series', libraryId: library.id })
    const author = await Database.authorModel.create({ name: 'An Author', libraryId: library.id })

    const defs = [
      { key: 'multi', title: 'A Multi', audioFiles: [audioFile(1), audioFile(2, 200), audioFile(3, 300, { exclude: true })], seq: '1' },
      { key: 'single', title: 'B Single', audioFiles: [audioFile(4, 400)], seq: '2' },
      { key: 'ebook', title: 'C Ebook', audioFiles: [], ebookFile: { ino: 'e', ebookFormat: 'epub', metadata: { filename: 'c.epub', size: 55 } } },
      { key: 'plain', title: 'D Plain', audioFiles: [audioFile(5), audioFile(6), audioFile(7)] }
    ]
    for (const def of defs) {
      const book = await Database.bookModel.create({ title: def.title, titleIgnorePrefix: def.title, duration: 120, audioFiles: def.audioFiles, ebookFile: def.ebookFile || null, chapters: [{ id: 0, start: 0, end: 10, title: 'c' }] })
      const item = await Database.libraryItemModel.create({
        mediaId: book.id,
        mediaType: 'book',
        libraryId: library.id,
        libraryFolderId: folder.id,
        title: def.title,
        titleIgnorePrefix: def.title,
        size: 1000,
        libraryFiles: [{ ino: 'x', metadata: { filename: 'x.mp3', size: 1 } }, ...(def.ebookFile ? [{ ino: 'e', isSupplementary: true, metadata: { filename: 'c.epub', size: 55 } }] : [])]
      })
      itemIds[def.key] = item.id
      await Database.bookAuthorModel.create({ bookId: book.id, authorId: author.id })
      if (def.seq) await Database.bookSeriesModel.create({ bookId: book.id, seriesId: series.id, sequence: def.seq })
    }
  })

  /** The listing JSON of an item must equal the JSON built from a fully loaded item */
  const expectParity = async (listed) => {
    const full = await Database.libraryItemModel.getExpandedById(listed.id)
    const expected = full.toOldJSONMinified()
    expect(listed.media.numTracks, listed.id).to.equal(expected.media.numTracks)
    expect(listed.media.numAudioFiles).to.equal(expected.media.numAudioFiles)
    expect(listed.media.numChapters).to.equal(expected.media.numChapters)
    expect(listed.media.size).to.equal(expected.media.size)
    expect(listed.numFiles).to.equal(expected.numFiles)
  }

  it('lists all items sorted by title with the same counts as a full load', async () => {
    const { libraryItems, count } = await listing()
    expect(count).to.equal(4)
    expect(libraryItems.map((li) => li.media.metadata.title)).to.deep.equal(['A Multi', 'B Single', 'C Ebook', 'D Plain'])
    expect(libraryItems.find((li) => li.id === itemIds.multi).media).to.include({ numTracks: 2, numAudioFiles: 3, numChapters: 1, size: 600 })
    expect(libraryItems.find((li) => li.id === itemIds.ebook)).to.include({ numFiles: 2 })
    for (const li of libraryItems) await expectParity(li)
  })

  it('does not load the side rows', async () => {
    const { libraryItems } = await libraryFilters.getFilteredLibraryItems(library.id, user, { sortBy: 'media.metadata.title', limit: 50, offset: 0, include: [], mediaType: 'book' })
    expect(libraryItems).to.have.length(4)
    for (const li of libraryItems) {
      expect(li.libraryItemFile, 'libraryItemFile').to.equal(undefined)
      expect(li.media.bookFile, 'bookFile').to.equal(undefined)
    }
  })

  it('filters on the number of tracks without the JSON', async () => {
    expect((await listing({ filterBy: `tracks.${b64('multi')}` })).libraryItems.map((li) => li.media.metadata.title)).to.deep.equal(['A Multi', 'D Plain'])
    expect((await listing({ filterBy: `tracks.${b64('single')}` })).libraryItems.map((li) => li.media.metadata.title)).to.deep.equal(['B Single'])
    expect((await listing({ filterBy: `tracks.${b64('none')}` })).libraryItems.map((li) => li.media.metadata.title)).to.deep.equal(['C Ebook'])
  })

  it('filters on supplementary ebooks using the library files side table', async () => {
    const withSupp = await listing({ filterBy: `ebooks.${b64('supplementary')}` })
    expect(withSupp.libraryItems.map((li) => li.id)).to.deep.equal([itemIds.ebook])
    const without = await listing({ filterBy: `ebooks.${b64('no-supplementary')}` })
    expect(without.libraryItems.map((li) => li.id)).to.have.members([itemIds.multi, itemIds.single, itemIds.plain])
  })

  it('lists collapsed series and sorted by added date', async () => {
    const collapsed = await listing({ collapseseries: true })
    expect(collapsed.libraryItems.find((li) => li.collapsedSeries)).to.not.equal(undefined)
    for (const li of collapsed.libraryItems) await expectParity(li)
    const recent = await listing({ sortBy: 'addedAt', sortDesc: true })
    expect(recent.libraryItems).to.have.length(4)
  })

  it('home shelves (continue series, recently added, discover) still work', async () => {
    const recent = await libraryFilters.getLibraryItemsMostRecentlyAdded(library, user, [], 10)
    expect(recent.libraryItems).to.have.length(4)
    const discover = await libraryFilters.getLibraryItemsToDiscover(library, user, [], 10)
    expect(discover.libraryItems.length).to.be.greaterThan(0)
    for (const li of [...recent.libraryItems, ...discover.libraryItems]) await expectParity(li)
    const shelves = await Database.libraryItemModel.getPersonalizedShelves(library, user, [], 10)
    expect(shelves.map((s) => s.id)).to.include('recently-added')
  })
})

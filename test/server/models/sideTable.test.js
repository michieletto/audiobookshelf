const { expect } = require('chai')
const { Sequelize } = require('sequelize')

const Database = require('../../../server/Database')

const audioFile = (n, size = 100, extra = {}) => ({ index: n, ino: `${n}`, metadata: { filename: `${n}.mp3`, ext: '.mp3', path: `/b/${n}.mp3`, relPath: `${n}.mp3`, size }, ...extra })

describe('side tables for audioFiles, chapters and libraryFiles', () => {
  let book
  let libraryItem

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    const library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
    const folder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })
    book = await Database.bookModel.create({
      title: 'Book',
      audioFiles: [audioFile(1, 100), audioFile(2, 200), audioFile(3, 300, { exclude: true })],
      chapters: [{ id: 0, start: 0, end: 10, title: 'One' }],
      ebookFile: { ino: 'e', metadata: { filename: 'b.epub', size: 50 } }
    })
    libraryItem = await Database.libraryItemModel.create({
      mediaId: book.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: folder.id,
      libraryFiles: [{ ino: '1' }, { ino: '2' }]
    })
  })

  const rawBookRow = () => Database.sequelize.query('SELECT * FROM books WHERE id = :id', { replacements: { id: book.id }, type: Sequelize.QueryTypes.SELECT }).then((r) => r[0])

  it('creates the side rows and the count columns', async () => {
    expect(await Database.bookFileModel.count()).to.equal(1)
    expect(await Database.libraryItemFileModel.count()).to.equal(1)
    const row = await rawBookRow()
    expect(row).to.not.have.property('audioFiles')
    expect(row).to.not.have.property('chapters')
    expect(row).to.include({ numAudioFiles: 3, numTracks: 2, numChapters: 1, audioFilesSize: 600 })
    const item = await Database.sequelize.query('SELECT * FROM libraryItems WHERE id = :id', { replacements: { id: libraryItem.id }, type: Sequelize.QueryTypes.SELECT })
    expect(item[0]).to.not.have.property('libraryFiles')
    expect(item[0].numFiles).to.equal(2)
  })

  it('stores audioFiles and chapters compressed and libraryFiles as plain JSON', async () => {
    const [files] = await Database.sequelize.query('SELECT audioFiles, chapters FROM bookFiles', { type: Sequelize.QueryTypes.SELECT, raw: true }).then((rows) => rows)
    expect(Buffer.isBuffer(files.audioFiles)).to.equal(true)
    expect(JSON.parse(require('zlib').inflateSync(files.audioFiles).toString())).to.have.length(3)
    const [items] = await Database.sequelize.query('SELECT libraryFiles FROM libraryItemFiles', { type: Sequelize.QueryTypes.SELECT })
    expect(JSON.parse(items.libraryFiles)).to.have.length(2)
  })

  it('persists an in-place change of the compressed JSON and null chapters', async () => {
    const found = await Database.bookModel.findByPk(book.id)
    found.audioFiles[1].duration = 99
    found.changed('audioFiles', true)
    found.chapters = null
    await found.save()
    const reloaded = await Database.bookModel.findByPk(book.id)
    expect(reloaded.audioFiles[1].duration).to.equal(99)
    expect(reloaded.chapters).to.equal(null)
    expect(await rawBookRow()).to.include({ numChapters: 0 })
  })

  it('loads audioFiles, chapters and libraryFiles with a normal find', async () => {
    const found = await Database.bookModel.findByPk(book.id)
    expect(found.audioFiles).to.have.length(3)
    expect(found.chapters[0].title).to.equal('One')
    const item = await Database.libraryItemModel.findByPk(libraryItem.id)
    expect(item.libraryFiles).to.have.length(2)
  })

  it('loads the files of a book included through a library item', async () => {
    const item = await Database.libraryItemModel.findOne({ where: { id: libraryItem.id }, include: Database.bookModel })
    expect(item.media.audioFiles).to.have.length(3)
    expect(item.libraryFiles).to.have.length(2)
  })

  it('does not load the files with unscoped() and falls back to the stored counts', async () => {
    const lean = await Database.bookModel.unscoped().findByPk(book.id)
    expect(lean.bookFile).to.equal(undefined)
    expect(lean.audioFiles).to.equal(undefined)
    expect(lean.size).to.equal(650)
    const item = await Database.libraryItemModel.unscoped().findOne({ where: { id: libraryItem.id }, include: { model: Database.bookModel.unscoped() } })
    expect(item.libraryItemFile).to.equal(undefined)
    item.media.authors = []
    item.media.series = []
    expect(item.media.toOldJSONMinified()).to.include({ numTracks: 2, numAudioFiles: 3, numChapters: 1, size: 650 })
  })

  it('minified JSON is identical with and without the files loaded', async () => {
    const full = await Database.bookModel.findByPk(book.id)
    const lean = await Database.bookModel.unscoped().findByPk(book.id)
    for (const b of [full, lean]) {
      b.authors = []
      b.series = []
    }
    expect(lean.toOldJSONMinified()).to.deep.equal(full.toOldJSONMinified())
  })

  it('saves in-place changes flagged with changed()', async () => {
    const found = await Database.bookModel.findByPk(book.id)
    found.audioFiles.push(audioFile(4, 400))
    found.audioFiles[0].exclude = true
    found.changed('audioFiles', true)
    await found.save()

    const reloaded = await Database.bookModel.findByPk(book.id)
    expect(reloaded.audioFiles).to.have.length(4)
    expect(reloaded.audioFiles[0].exclude).to.equal(true)
    expect(await rawBookRow()).to.include({ numAudioFiles: 4, numTracks: 2, audioFilesSize: 1000 })
  })

  it('saves files assigned through update() and keeps the other fields', async () => {
    await book.update({ audioFiles: [audioFile(9, 10)], title: 'Renamed' })
    const reloaded = await Database.bookModel.findByPk(book.id)
    expect(reloaded.title).to.equal('Renamed')
    expect(reloaded.audioFiles).to.have.length(1)
    expect(await rawBookRow()).to.include({ numAudioFiles: 1, numTracks: 1, audioFilesSize: 10 })
  })

  it('does not touch the side row when only other columns change', async () => {
    const found = await Database.bookModel.findByPk(book.id)
    await found.update({ title: 'Only title' })
    const reloaded = await Database.bookModel.findByPk(book.id)
    expect(reloaded.audioFiles).to.have.length(3)
    expect(reloaded.title).to.equal('Only title')
  })

  it('saves libraryFiles changes and the count', async () => {
    const item = await Database.libraryItemModel.findByPk(libraryItem.id)
    item.libraryFiles.push({ ino: '3' })
    item.changed('libraryFiles', true)
    await item.save()
    const reloaded = await Database.libraryItemModel.findByPk(libraryItem.id)
    expect(reloaded.libraryFiles).to.have.length(3)
    const [row] = await Database.sequelize.query('SELECT numFiles FROM libraryItems WHERE id = :id', { replacements: { id: libraryItem.id }, type: Sequelize.QueryTypes.SELECT })
    expect(row.numFiles).to.equal(3)
  })

  it('deletes the side rows with the book and the library item', async () => {
    await Database.libraryItemModel.destroy({ where: { id: libraryItem.id } })
    await Database.bookModel.destroy({ where: { id: book.id } })
    expect(await Database.bookFileModel.count()).to.equal(0)
    expect(await Database.libraryItemFileModel.count()).to.equal(0)
  })

  it('saves the side rows of a library item created together with its book (scanner path)', async () => {
    const library = await Database.libraryModel.findOne()
    const folder = await Database.libraryFolderModel.findOne()
    const created = await Database.libraryItemModel.create(
      {
        mediaType: 'book',
        libraryId: library.id,
        libraryFolderId: folder.id,
        libraryFiles: [{ ino: 'n1' }],
        book: { title: 'Scanned', audioFiles: [audioFile(1, 10), audioFile(2, 20)], chapters: [{ id: 0, start: 0, end: 5, title: 'x' }] }
      },
      { include: { model: Database.bookModel } }
    )
    expect(created.book.id).to.be.a('string')
    const item = await Database.libraryItemModel.getExpandedById(created.id)
    expect(item.libraryFiles).to.have.length(1)
    expect(item.media.audioFiles).to.have.length(2)
    expect(item.media.chapters).to.have.length(1)
    const [row] = await Database.sequelize.query('SELECT numAudioFiles, audioFilesSize, numChapters FROM books WHERE id = :id', { replacements: { id: created.book.id }, type: Sequelize.QueryTypes.SELECT })
    expect(row).to.deep.equal({ numAudioFiles: 2, audioFilesSize: 30, numChapters: 1 })
  })

  it('loads the side rows when queries pass a single object include, also nested', async () => {
    const item = await Database.libraryItemModel.findOne({
      where: { id: libraryItem.id },
      include: { model: Database.bookModel, include: { model: Database.bookSeriesModel } }
    })
    expect(item.libraryFiles).to.have.length(2)
    expect(item.media.audioFiles).to.have.length(3)

    const found = await Database.bookModel.findOne({ where: { id: book.id }, include: { model: Database.libraryItemModel } })
    expect(found.audioFiles).to.have.length(3)
    expect(found.libraryItem.libraryFiles).to.have.length(2)
  })

  it('does not load the side rows when a query lists the attributes it needs', async () => {
    const lean = await Database.bookModel.findByPk(book.id, { attributes: ['id', 'numTracks'], include: { model: Database.libraryItemModel, attributes: ['id', 'mediaId'] } })
    expect(lean.numTracks).to.equal(2)
    expect(lean.bookFile).to.equal(undefined)
    expect(lean.libraryItem.libraryItemFile).to.equal(undefined)
  })

  it('loads the side rows when the listed attributes include a side table field', async () => {
    const found = await Database.bookModel.findByPk(book.id, { attributes: ['id', 'audioFiles'] })
    expect(found.audioFiles).to.have.length(3)
    const items = await Database.libraryItemModel.findAll({ attributes: ['id', 'libraryFiles'] })
    expect(items[0].libraryFiles).to.have.length(2)
  })

  it('findOneExpanded loads books with their files', async () => {
    const item = await Database.libraryItemModel.findOneExpanded({ id: libraryItem.id })
    expect(item.media.audioFiles).to.have.length(3)
    expect(item.libraryFiles).to.have.length(2)
  })
})

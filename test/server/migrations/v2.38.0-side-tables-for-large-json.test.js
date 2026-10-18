const zlib = require('zlib')
const chai = require('chai')
const sinon = require('sinon')
const { expect } = chai

const { DataTypes, Sequelize } = require('sequelize')
const Logger = require('../../../server/Logger')

const { up, down } = require('../../../server/migrations/v2.38.0-side-tables-for-large-json')

describe('Migration v2.38.0-side-tables-for-large-json', () => {
  let sequelize
  let queryInterface
  const audioFiles = [{ ino: '1', metadata: { size: 100 } }, { ino: '2', exclude: true, metadata: { size: 250 } }, { ino: '3', exclude: false, metadata: { size: 50 } }]
  const chapters = [
    { id: 0, title: 'a' },
    { id: 1, title: 'b' }
  ]
  const libraryFiles = [{ ino: '1' }, { ino: '2' }, { ino: '3' }, { ino: '4' }]

  const unpack = (blob) => JSON.parse(zlib.inflateSync(blob).toString())
  const query = (sql) => sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT })

  beforeEach(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    queryInterface = sequelize.getQueryInterface()
    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    await sequelize.query('PRAGMA foreign_keys = ON')

    await queryInterface.createTable('books', {
      id: { type: DataTypes.UUID, primaryKey: true },
      title: DataTypes.STRING,
      audioFiles: DataTypes.JSON,
      ebookFile: DataTypes.JSON,
      chapters: DataTypes.JSON
    })
    await queryInterface.createTable('libraryItems', {
      id: { type: DataTypes.UUID, primaryKey: true },
      mediaId: DataTypes.UUID,
      libraryFiles: DataTypes.JSON
    })
    await queryInterface.addIndex('books', ['title'])
    await queryInterface.addIndex('libraryItems', ['mediaId'])

    await queryInterface.bulkInsert('books', [
      { id: 'b1', title: 'one', audioFiles: JSON.stringify(audioFiles), chapters: JSON.stringify(chapters) },
      { id: 'b2', title: 'two', audioFiles: JSON.stringify([]), chapters: null }
    ])
    await queryInterface.bulkInsert('libraryItems', [
      { id: 'l1', mediaId: 'b1', libraryFiles: JSON.stringify(libraryFiles) },
      { id: 'l2', mediaId: 'b2', libraryFiles: JSON.stringify([]) }
    ])
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('up', () => {
    it('moves the JSON to side tables and fills the count columns', async () => {
      await up({ context: { queryInterface, logger: Logger } })

      const bookColumns = Object.keys(await queryInterface.describeTable('books'))
      expect(bookColumns).to.not.include('audioFiles')
      expect(bookColumns).to.not.include('chapters')
      expect(bookColumns).to.include.members(['numAudioFiles', 'numTracks', 'numChapters', 'audioFilesSize', 'ebookFile'])
      expect(Object.keys(await queryInterface.describeTable('libraryItems'))).to.not.include('libraryFiles')

      const [b1, b2] = await query('SELECT * FROM books ORDER BY id')
      expect(b1).to.include({ numAudioFiles: 3, numTracks: 2, numChapters: 2, audioFilesSize: 400 })
      expect(b2).to.include({ numAudioFiles: 0, numTracks: 0, numChapters: 0, audioFilesSize: 0 })
      const [l1] = await query('SELECT numFiles FROM libraryItems ORDER BY id')
      expect(l1.numFiles).to.equal(4)

      const [f1, f2] = await query('SELECT * FROM bookFiles ORDER BY bookId')
      expect(unpack(f1.audioFiles)).to.deep.equal(audioFiles)
      expect(unpack(f1.chapters)).to.deep.equal(chapters)
      expect(unpack(f2.audioFiles)).to.deep.equal([])
      expect(f2.chapters).to.equal(null)
      const [lf1] = await query('SELECT * FROM libraryItemFiles ORDER BY libraryItemId')
      expect(JSON.parse(lf1.libraryFiles)).to.deep.equal(libraryFiles)
    })

    it('keeps the indexes of the main tables', async () => {
      await up({ context: { queryInterface, logger: Logger } })
      expect((await queryInterface.showIndex('books')).some((i) => i.fields.some((f) => f.attribute === 'title'))).to.equal(true)
      expect((await queryInterface.showIndex('libraryItems')).some((i) => i.fields.some((f) => f.attribute === 'mediaId'))).to.equal(true)
    })

    it('deletes the side rows with the book', async () => {
      await up({ context: { queryInterface, logger: Logger } })
      await sequelize.query("DELETE FROM books WHERE id = 'b1'")
      expect(await query('SELECT * FROM bookFiles')).to.have.length(1)
    })

    it('can run twice', async () => {
      await up({ context: { queryInterface, logger: Logger } })
      await up({ context: { queryInterface, logger: Logger } })
      expect(await query('SELECT * FROM bookFiles')).to.have.length(2)
      expect((await query("SELECT * FROM books WHERE id = 'b1'"))[0]).to.include({ numAudioFiles: 3 })
    })
  })

  describe('down', () => {
    it('restores the JSON columns and drops the side tables', async () => {
      await up({ context: { queryInterface, logger: Logger } })
      await down({ context: { queryInterface, logger: Logger } })

      expect(await queryInterface.tableExists('bookFiles')).to.equal(false)
      expect(await queryInterface.tableExists('libraryItemFiles')).to.equal(false)
      expect(Object.keys(await queryInterface.describeTable('books'))).to.not.include('numAudioFiles')

      const [b1] = await query("SELECT * FROM books WHERE id = 'b1'")
      expect(JSON.parse(b1.audioFiles)).to.deep.equal(audioFiles)
      expect(JSON.parse(b1.chapters)).to.deep.equal(chapters)
      const [l1] = await query("SELECT * FROM libraryItems WHERE id = 'l1'")
      expect(JSON.parse(l1.libraryFiles)).to.deep.equal(libraryFiles)
    })
  })
})

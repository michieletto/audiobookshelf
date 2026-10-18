const zlib = require('zlib')
const { DataTypes, Model } = require('sequelize')

/**
 * JSON stored as a zlib-compressed BLOB. The entries of a book repeat the same tags, paths and keys for every file,
 * so it compresses ~14x. Nothing queries inside these columns (the listing queries use the count columns on books).
 *
 * The parsed value is cached on the instance because callers mutate it in place and then flag it with `changed()`.
 * It is serialized in `beforeSave` for the fields that are flagged as changed.
 *
 * @param {string} field
 */
function compressedJsonAttribute(field) {
  return {
    type: DataTypes.BLOB,
    get() {
      this.jsonCache ||= {}
      if (!(field in this.jsonCache)) {
        const stored = this.getDataValue(field)
        this.jsonCache[field] = stored === null || stored === undefined ? stored : JSON.parse(zlib.inflateSync(stored).toString())
      }
      return this.jsonCache[field]
    },
    set(value) {
      this.jsonCache ||= {}
      this.jsonCache[field] = value
      this.changed(field, true)
    }
  }
}

/**
 * Large JSON of a book, kept out of the books table so listing queries never read it.
 * Accessed through `book.audioFiles` / `book.chapters`.
 */
class BookFile extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {UUIDV4} */
    this.bookId
    /** @type {import('./Book').AudioFileObject[]} */
    this.audioFiles
    /** @type {import('./Book').ChapterObject[]} */
    this.chapters
  }

  /**
   * Initialize model
   * @param {import('../Database').sequelize} sequelize
   */
  static init(sequelize) {
    super.init(
      {
        bookId: {
          type: DataTypes.UUID,
          primaryKey: true
        },
        audioFiles: compressedJsonAttribute('audioFiles'),
        chapters: compressedJsonAttribute('chapters')
      },
      {
        sequelize,
        modelName: 'bookFile',
        timestamps: false,
        hooks: {
          beforeSave(instance) {
            for (const field of ['audioFiles', 'chapters']) {
              if (!instance.changed(field) || !instance.jsonCache || !(field in instance.jsonCache)) continue
              const value = instance.jsonCache[field]
              instance.setDataValue(field, value === null || value === undefined ? null : zlib.deflateSync(Buffer.from(JSON.stringify(value))))
            }
          }
        }
      }
    )

    const { book } = sequelize.models
    book.hasOne(BookFile, { foreignKey: 'bookId', as: 'bookFile', onDelete: 'CASCADE' })
    BookFile.belongsTo(book, { foreignKey: 'bookId' })

    // Load the side row with every book query. Listing queries use `book.unscoped()` to skip it.
    book.addScope('defaultScope', { include: [{ model: BookFile, as: 'bookFile' }] }, { override: true })
  }
}

module.exports = BookFile

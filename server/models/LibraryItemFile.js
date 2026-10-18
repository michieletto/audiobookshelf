const { DataTypes, Model } = require('sequelize')

/**
 * Large JSON of a library item, kept out of the libraryItems table so listing queries never read it.
 * Accessed through `libraryItem.libraryFiles`.
 */
class LibraryItemFile extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {UUIDV4} */
    this.libraryItemId
    /** @type {import('./LibraryItem').LibraryFileObject[]} */
    this.libraryFiles
  }

  /**
   * Initialize model
   * @param {import('../Database').sequelize} sequelize
   */
  static init(sequelize) {
    super.init(
      {
        libraryItemId: {
          type: DataTypes.UUID,
          primaryKey: true
        },
        libraryFiles: DataTypes.JSON
      },
      {
        sequelize,
        modelName: 'libraryItemFile',
        timestamps: false
      }
    )

    const { libraryItem } = sequelize.models
    libraryItem.hasOne(LibraryItemFile, { foreignKey: 'libraryItemId', as: 'libraryItemFile', onDelete: 'CASCADE' })
    LibraryItemFile.belongsTo(libraryItem, { foreignKey: 'libraryItemId' })

    libraryItem.addScope('defaultScope', { include: [{ model: LibraryItemFile, as: 'libraryItemFile' }] }, { override: true })
  }
}

module.exports = LibraryItemFile

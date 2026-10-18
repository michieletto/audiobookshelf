/**
 * @typedef MigrationContext
 * @property {import('sequelize').QueryInterface} queryInterface - a Sequelize QueryInterface object.
 * @property {import('../Logger')} logger - a Logger object.
 *
 * @typedef MigrationOptions
 * @property {MigrationContext} context - an object containing the migration context.
 */

const migrationVersion = '2.38.0'
const zlib = require('zlib')

const migrationName = `${migrationVersion}-side-tables-for-large-json`
const loggerPrefix = `[${migrationVersion} migration]`

/** @param {string|null} text */
const compress = (text) => (text === null || text === undefined ? null : zlib.deflateSync(Buffer.from(text)))
/** @param {Buffer|null} blob */
const decompress = (blob) => (blob === null || blob === undefined ? null : zlib.inflateSync(blob).toString())

/**
 * Copy rows in batches inside a transaction (one commit per batch instead of one per row).
 * The rows are read by rowid so nothing is held in memory but one batch.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @param {{ selectSql: string, insertSql: string, values: (row: Object) => any[] }} options
 */
async function copyJson(sequelize, { selectSql, insertSql, values }) {
  const batch = 100
  let last = 0
  for (;;) {
    const [rows] = await sequelize.query(selectSql, { replacements: { last, batch } })
    if (!rows.length) break
    await sequelize.query('BEGIN')
    try {
      for (const row of rows) {
        await sequelize.query(insertSql, { replacements: values(row) })
      }
      await sequelize.query('COMMIT')
    } catch (error) {
      await sequelize.query('ROLLBACK')
      throw error
    }
    last = rows[rows.length - 1].rid
  }
}

/**
 * This migration moves the large JSON columns out of the books and libraryItems tables:
 *  - books.audioFiles, books.chapters -> bookFiles
 *  - libraryItems.libraryFiles -> libraryItemFiles
 *
 * SQLite stores a row as one record and reads a column by walking everything before it, so with the JSON in the
 * row every listing query read tens of KB of it per book (a book with one file per chapter has 100s of KB).
 * audioFiles and chapters are stored zlib-compressed (the entries repeat the same tags and paths for every file, ~14x).
 * libraryFiles stays plain JSON because the scanner and a few filters search inside it.
 * The small count columns (numAudioFiles, numTracks, numChapters, audioFilesSize, numFiles) replace the JSON in listings.
 *
 * @param {MigrationOptions} options - an object containing the migration context.
 * @returns {Promise<void>} - A promise that resolves when the migration is complete.
 */
async function up({ context: { queryInterface, logger } }) {
  logger.info(`${loggerPrefix} UPGRADE BEGIN: ${migrationName}`)
  const { DataTypes } = queryInterface.sequelize.Sequelize
  const sequelize = queryInterface.sequelize

  const hasColumn = async (table, column) => !!(await queryInterface.describeTable(table))[column]
  // Sequelize's removeColumn rebuilds the whole table on SQLite (dropping indexes and triggers), use SQLite's native DROP COLUMN
  const dropColumn = (table, column) => sequelize.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``)

  // books: side table + count columns
  if (await queryInterface.tableExists('books')) {
    if (!(await queryInterface.tableExists('bookFiles'))) {
      logger.info(`${loggerPrefix} Creating bookFiles table`)
      await queryInterface.createTable('bookFiles', {
        bookId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, references: { model: 'books', key: 'id' }, onDelete: 'CASCADE' },
        // zlib-compressed JSON text
        audioFiles: DataTypes.BLOB,
        chapters: DataTypes.BLOB
      })
    }
    for (const [column, definition] of [
      ['numAudioFiles', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }],
      ['numTracks', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }],
      ['numChapters', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }],
      ['audioFilesSize', { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 }]
    ]) {
      if (!(await hasColumn('books', column))) {
        logger.info(`${loggerPrefix} Adding ${column} column to books table`)
        await queryInterface.addColumn('books', column, definition)
      }
    }

    if (await hasColumn('books', 'audioFiles')) {
      logger.info(`${loggerPrefix} Copying audioFiles and chapters to bookFiles`)
      await copyJson(sequelize, {
        selectSql: 'SELECT rowid AS rid, id, audioFiles, chapters FROM books WHERE rowid > :last ORDER BY rowid LIMIT :batch',
        insertSql: 'INSERT OR REPLACE INTO bookFiles (bookId, audioFiles, chapters) VALUES (?, ?, ?)',
        values: (row) => [row.id, compress(row.audioFiles), compress(row.chapters)]
      })

      logger.info(`${loggerPrefix} Filling book count columns`)
      await sequelize.query(`
        UPDATE books SET
          numAudioFiles = CASE WHEN json_valid(audioFiles) THEN COALESCE(json_array_length(audioFiles), 0) ELSE 0 END,
          numTracks = CASE WHEN json_valid(audioFiles) THEN (SELECT COUNT(*) FROM json_each(books.audioFiles) WHERE NOT COALESCE(json_extract(json_each.value, '$.exclude'), 0)) ELSE 0 END,
          numChapters = CASE WHEN json_valid(chapters) THEN COALESCE(json_array_length(chapters), 0) ELSE 0 END,
          audioFilesSize = CASE WHEN json_valid(audioFiles) THEN COALESCE((SELECT SUM(COALESCE(json_extract(json_each.value, '$.metadata.size'), 0)) FROM json_each(books.audioFiles)), 0) ELSE 0 END
      `)

      logger.info(`${loggerPrefix} Dropping audioFiles and chapters columns from books table`)
      await dropColumn('books', 'audioFiles')
      await dropColumn('books', 'chapters')
    }
  } else {
    logger.info(`${loggerPrefix} books table does not exist`)
  }

  // libraryItems: side table + count column
  if (await queryInterface.tableExists('libraryItems')) {
    if (!(await queryInterface.tableExists('libraryItemFiles'))) {
      logger.info(`${loggerPrefix} Creating libraryItemFiles table`)
      await queryInterface.createTable('libraryItemFiles', {
        libraryItemId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, references: { model: 'libraryItems', key: 'id' }, onDelete: 'CASCADE' },
        libraryFiles: DataTypes.JSON
      })
    }
    if (!(await hasColumn('libraryItems', 'numFiles'))) {
      logger.info(`${loggerPrefix} Adding numFiles column to libraryItems table`)
      await queryInterface.addColumn('libraryItems', 'numFiles', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 })
    }

    if (await hasColumn('libraryItems', 'libraryFiles')) {
      logger.info(`${loggerPrefix} Copying libraryFiles to libraryItemFiles`)
      await sequelize.query('INSERT OR REPLACE INTO libraryItemFiles (libraryItemId, libraryFiles) SELECT id, libraryFiles FROM libraryItems')

      logger.info(`${loggerPrefix} Filling libraryItems numFiles`)
      await sequelize.query('UPDATE libraryItems SET numFiles = CASE WHEN json_valid(libraryFiles) THEN COALESCE(json_array_length(libraryFiles), 0) ELSE 0 END')

      logger.info(`${loggerPrefix} Dropping libraryFiles column from libraryItems table`)
      await dropColumn('libraryItems', 'libraryFiles')
    }
  } else {
    logger.info(`${loggerPrefix} libraryItems table does not exist`)
  }

  // Dropping columns only frees pages inside the file, rewrite it so it shrinks
  try {
    logger.info(`${loggerPrefix} Running VACUUM to reclaim the space of the dropped columns`)
    await sequelize.query('VACUUM')
  } catch (error) {
    logger.warn(`${loggerPrefix} VACUUM failed, the database file will not shrink until the next VACUUM: ${error.message}`)
  }

  logger.info(`${loggerPrefix} UPGRADE END: ${migrationName}`)
}

/**
 * This migration script moves the JSON columns back into the books and libraryItems tables and drops the side tables.
 *
 * @param {MigrationOptions} options - an object containing the migration context.
 * @returns {Promise<void>} - A promise that resolves when the migration is complete.
 */
async function down({ context: { queryInterface, logger } }) {
  logger.info(`${loggerPrefix} DOWNGRADE BEGIN: ${migrationName}`)
  const { DataTypes } = queryInterface.sequelize.Sequelize
  const sequelize = queryInterface.sequelize

  const hasColumn = async (table, column) => !!(await queryInterface.describeTable(table))[column]
  // Sequelize's removeColumn rebuilds the whole table on SQLite (dropping indexes and triggers), use SQLite's native DROP COLUMN
  const dropColumn = (table, column) => sequelize.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``)

  if (await queryInterface.tableExists('books')) {
    if (await queryInterface.tableExists('bookFiles')) {
      for (const column of ['audioFiles', 'chapters']) {
        if (!(await hasColumn('books', column))) {
          logger.info(`${loggerPrefix} Adding ${column} column to books table`)
          await queryInterface.addColumn('books', column, DataTypes.JSON)
        }
      }
      logger.info(`${loggerPrefix} Copying bookFiles back into books`)
      await copyJson(sequelize, {
        selectSql: 'SELECT rowid AS rid, bookId, audioFiles, chapters FROM bookFiles WHERE rowid > :last ORDER BY rowid LIMIT :batch',
        insertSql: 'UPDATE books SET audioFiles = ?, chapters = ? WHERE id = ?',
        values: (row) => [decompress(row.audioFiles), decompress(row.chapters), row.bookId]
      })
      await queryInterface.dropTable('bookFiles')
    }
    for (const column of ['numAudioFiles', 'numTracks', 'numChapters', 'audioFilesSize']) {
      if (await hasColumn('books', column)) {
        logger.info(`${loggerPrefix} Removing ${column} column from books table`)
        await dropColumn('books', column)
      }
    }
  }

  if (await queryInterface.tableExists('libraryItems')) {
    if (await queryInterface.tableExists('libraryItemFiles')) {
      if (!(await hasColumn('libraryItems', 'libraryFiles'))) {
        logger.info(`${loggerPrefix} Adding libraryFiles column to libraryItems table`)
        await queryInterface.addColumn('libraryItems', 'libraryFiles', DataTypes.JSON)
      }
      logger.info(`${loggerPrefix} Copying libraryItemFiles back into libraryItems`)
      await sequelize.query('UPDATE libraryItems SET libraryFiles = (SELECT libraryFiles FROM libraryItemFiles WHERE libraryItemFiles.libraryItemId = libraryItems.id)')
      await queryInterface.dropTable('libraryItemFiles')
    }
    if (await hasColumn('libraryItems', 'numFiles')) {
      logger.info(`${loggerPrefix} Removing numFiles column from libraryItems table`)
      await dropColumn('libraryItems', 'numFiles')
    }
  }

  logger.info(`${loggerPrefix} DOWNGRADE END: ${migrationName}`)
}

module.exports = { up, down }

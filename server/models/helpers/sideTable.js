const { DataTypes } = require('sequelize')

/**
 * Some large JSON columns (book audio files and chapters, library item files) live in a 1:1 "side table" so the
 * main table rows stay small. These helpers make them look like normal attributes on the main model:
 * `instance.audioFiles` reads from the loaded side row and assigning/saving writes it back.
 *
 * @typedef SideTableConfig
 * @property {string} assoc - name of the hasOne association (also the property holding the loaded side row)
 * @property {string} model - side table model name
 * @property {string} foreignKey - primary/foreign key column of the side table
 * @property {string[]} fields - attributes stored in the side table
 * @property {(instance: import('sequelize').Model) => Object} [deriveColumns] - small columns on the main table kept in sync
 */

/**
 * Virtual attribute definition that reads/writes `field` of the side row.
 * The side row is built on demand so that `Model.create({ audioFiles })` works.
 *
 * @param {SideTableConfig} config
 * @param {string} field
 */
function sideAttribute(config, field) {
  return {
    type: DataTypes.VIRTUAL,
    get() {
      return this[config.assoc]?.[field]
    },
    set(value) {
      if (!this[config.assoc]) {
        this[config.assoc] = this.sequelize.models[config.model].build({ [config.foreignKey]: this.id })
      }
      this[config.assoc][field] = value
      this.changed(field, true)
    }
  }
}

/**
 * Persist the side row together with the main row.
 * Code mutates the JSON in place and then calls `changed(field, true)` + `save()`, so a field counts as dirty
 * when the main instance is flagged as changed for it.
 *
 * @param {import('sequelize').Model} instance
 * @param {Object} options - save options
 * @param {Function} save - the original save method
 * @param {SideTableConfig} config
 */
async function saveWithSideTable(instance, options, save, config) {
  const side = instance[config.assoc]
  const dirtyFields = side ? config.fields.filter((f) => instance.changed(f)) : []

  if (dirtyFields.length) {
    dirtyFields.forEach((f) => side.changed(f, true))
    if (config.deriveColumns) {
      const columns = config.deriveColumns(instance)
      for (const [key, value] of Object.entries(columns)) {
        instance.set(key, value)
        if (Array.isArray(options?.fields) && !options.fields.includes(key)) options.fields.push(key)
      }
    }
  }

  const result = await save.call(instance, options)

  if (dirtyFields.length) {
    side[config.foreignKey] = instance.id
    await side.save(options?.transaction ? { transaction: options.transaction } : undefined)
    dirtyFields.forEach((f) => instance.changed(f, false))
  }
  return result
}

/**
 * Sequelize merges the default scope's `include` array with the query's `include` only when both are arrays,
 * and otherwise the query's include replaces it. Many queries pass a single object (`include: { model: X }`),
 * so the query's include is turned into an array first, otherwise the side row would silently not be loaded.
 *
 * Call from a static `_injectScope(options)` override: it runs for top level queries and for included models.
 *
 * @param {Object} options - find options
 */
function normalizeScopeInclude(options) {
  if (!options) return
  if (options.include === null || options.include === undefined) {
    // An explicit null (e.g. findOneExpanded(where, replacements, include = null)) would also replace the scope's include
    delete options.include
  } else if (!Array.isArray(options.include)) {
    options.include = [options.include]
  }
}

/**
 * A query that lists the attributes it wants (e.g. `attributes: ['id', 'title']`) is asking for a lean result:
 * the side table is only loaded for it when it lists one of the side table fields (e.g. `attributes: ['id', 'libraryFiles']`).
 *
 * @param {Object} options - find options
 * @param {string[]} sideFields - attributes stored in the side table
 * @returns {boolean}
 */
function isLeanQuery(options, sideFields) {
  const attributes = options?.attributes
  if (!Array.isArray(attributes)) return false
  return !attributes.some((attr) => sideFields.includes(attr))
}

module.exports = { sideAttribute, saveWithSideTable, normalizeScopeInclude, isLeanQuery }

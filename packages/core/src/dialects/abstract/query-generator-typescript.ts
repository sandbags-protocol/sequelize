import NodeUtil from 'node:util';
import isObject from 'lodash/isObject';
import type { ModelStatic, Attributes, Model } from '../../model.js';
import { Op } from '../../operators.js';
import type { BindOrReplacements, Sequelize } from '../../sequelize.js';
import { bestGuessDataTypeOfVal } from '../../sql-string.js';
import { parseAttributeSyntax } from '../../utils/attribute.js';
import { isNullish, isPlainObject, isString } from '../../utils/check.js';
import { noOpCol } from '../../utils/deprecations.js';
import { quoteIdentifier } from '../../utils/dialect.js';
import { isModelStatic } from '../../utils/model-utils.js';
import { EMPTY_OBJECT } from '../../utils/object.js';
import {
  SequelizeMethod,
  Literal,
  Fn,
  List,
  Value,
  Identifier,
  Cast,
  Col,
  Where,
  Attribute, JsonPath, AssociationPath,
} from '../../utils/sequelize-method.js';
import { injectReplacements } from '../../utils/sql.js';
import { attributeTypeToSql, validateDataType } from './data-types-utils.js';
import type { DataType, BindParamOptions } from './data-types.js';
import type { AbstractQueryGenerator } from './query-generator.js';
import type { TableName, TableNameWithSchema } from './query-interface.js';
import type { WhereOptions } from './where-sql-builder-types.js';
import type { WhereBuilderOptions } from './where-sql-builder.js';
import { PojoWhere, WhereSqlBuilder } from './where-sql-builder.js';
import type { AbstractDialect } from './index.js';

export type TableNameOrModel = TableName | ModelStatic;

// keep REMOVE_INDEX_QUERY_SUPPORTABLE_OPTIONS updated when modifying this
export interface RemoveIndexQueryOptions {
  concurrently?: boolean;
  ifExists?: boolean;
  cascade?: boolean;
}

export const REMOVE_INDEX_QUERY_SUPPORTABLE_OPTIONS = new Set<keyof RemoveIndexQueryOptions>(['concurrently', 'ifExists', 'cascade']);

export interface QueryGeneratorOptions {
  sequelize: Sequelize;
  dialect: AbstractDialect;
}

/**
 * Options accepted by {@link AbstractQueryGeneratorTypeScript#escape}
 */
interface EscapeOptions extends Bindable {
  readonly type?: DataType | undefined;
}

interface FormatSequelizeMethodOptions extends Bindable {
  /**
   * These are used to inline replacements into the query
   */
  readonly replacements?: BindOrReplacements;
  readonly model?: ModelStatic;
}

/**
 * Methods that support this option are functions that add values to the query.
 * If {@link Bindable.bindParam} is specified, the value will be added to the query as a bind parameter.
 * If it is not specified, the value will be added to the query as a literal.
 */
export interface Bindable {
  bindParam?(value: unknown): string;
}

// DO NOT MAKE THIS CLASS PUBLIC!
/**
 * This is a temporary class used to progressively migrate the AbstractQueryGenerator class to TypeScript by slowly moving its functions here.
 * Always use {@link AbstractQueryGenerator} instead.
 */
export class AbstractQueryGeneratorTypeScript {

  private readonly whereSqlBuilder: WhereSqlBuilder;
  readonly dialect: AbstractDialect;
  protected readonly sequelize: Sequelize;

  constructor(options: QueryGeneratorOptions) {
    if (!options.sequelize) {
      throw new Error('QueryGenerator initialized without options.sequelize');
    }

    if (!options.dialect) {
      throw new Error('QueryGenerator initialized without options.dialect');
    }

    this.sequelize = options.sequelize;
    this.dialect = options.dialect;
    // TODO: remove casting once all AbstractQueryGenerator functions are moved here
    this.whereSqlBuilder = new WhereSqlBuilder(this as unknown as AbstractQueryGenerator);
  }

  protected get options() {
    return this.sequelize.options;
  }

  describeTableQuery(tableName: TableNameOrModel) {
    return `DESCRIBE ${this.quoteTable(tableName)};`;
  }

  showIndexesQuery(_tableName: TableNameOrModel): string {
    throw new Error(`showIndexesQuery has not been implemented in ${this.dialect.name}.`);
  }

  removeIndexQuery(
    _tableName: TableNameOrModel,
    _indexNameOrAttributes: string | string [],
    _options?: RemoveIndexQueryOptions,
  ): string {
    throw new Error(`removeIndexQuery has not been implemented in ${this.dialect.name}.`);
  }

  // TODO: rename to "normalizeTable" & move to sequelize class
  extractTableDetails(
    tableNameOrModel: TableNameOrModel,
    options?: { schema?: string, delimiter?: string },
  ): TableNameWithSchema {
    const tableNameObject = isModelStatic(tableNameOrModel) ? tableNameOrModel.getTableName()
      : isString(tableNameOrModel) ? { tableName: tableNameOrModel }
      : tableNameOrModel;

    if (!isPlainObject(tableNameObject)) {
      throw new Error(`Invalid input received, got ${NodeUtil.inspect(tableNameOrModel)}, expected a Model Class, a TableNameWithSchema object, or a table name string`);
    }

    // @ts-expect-error -- TODO: this is added by getTableName on model, and must be removed
    delete tableNameObject.toString;

    return {
      ...tableNameObject,
      schema: options?.schema || tableNameObject.schema || this.options.schema || this.dialect.getDefaultSchema(),
      delimiter: options?.delimiter || tableNameObject.delimiter || '.',
    };
  }

  /**
   * Quote table name with optional alias and schema attribution
   *
   * @param param table string or object
   * @param alias alias name
   */
  quoteTable(param: TableNameOrModel, alias: boolean | string = false): string {
    if (isModelStatic(param)) {
      param = param.getTableName();
    }

    const tableName = this.extractTableDetails(param);

    if (isObject(param) && ('as' in param || 'name' in param)) {
      throw new Error('parameters "as" and "name" are not allowed in the first parameter of quoteTable, pass them as the second parameter.');
    }

    if (alias === true) {
      alias = tableName.tableName;
    }

    let sql = '';

    if (this.dialect.supports.schemas) {
      // Some users sync the same set of tables in different schemas for various reasons
      // They then set `searchPath` when running a query to use different schemas.
      // See https://github.com/sequelize/sequelize/pull/15274#discussion_r1020770364
      // For this reason, we treat the default schema as equivalent to "no schema specified"
      if (tableName.schema && tableName.schema !== this.dialect.getDefaultSchema()) {
        sql += `${this.quoteIdentifier(tableName.schema)}.`;
      }

      sql += this.quoteIdentifier(tableName.tableName);
    } else {
      const fakeSchemaPrefix = (tableName.schema && tableName.schema !== this.dialect.getDefaultSchema())
        ? tableName.schema + (tableName.delimiter || '.')
        : '';

      sql += this.quoteIdentifier(fakeSchemaPrefix + tableName.tableName);
    }

    if (alias) {
      sql += ` AS ${this.quoteIdentifier(alias)}`;
    }

    return sql;
  }

  /**
   * Adds quotes to identifier
   *
   * @param identifier
   * @param _force
   */
  quoteIdentifier(identifier: string, _force?: boolean) {
    return quoteIdentifier(identifier, this.dialect.TICK_CHAR_LEFT, this.dialect.TICK_CHAR_RIGHT);
  }

  isSameTable(tableA: TableNameOrModel, tableB: TableNameOrModel) {
    if (tableA === tableB) {
      return true;
    }

    tableA = this.extractTableDetails(tableA);
    tableB = this.extractTableDetails(tableB);

    return tableA.tableName === tableB.tableName && tableA.schema === tableB.schema;
  }

  whereItemsQuery<M extends Model>(where: WhereOptions<Attributes<M>>, options?: WhereBuilderOptions) {
    return this.whereSqlBuilder.formatWhereOptions(where, options);
  }

  formatSequelizeMethod(piece: SequelizeMethod, options?: FormatSequelizeMethodOptions): string {
    if (piece instanceof Literal) {
      return this.formatLiteral(piece, options);
    }

    if (piece instanceof Fn) {
      return this.formatFn(piece, options);
    }

    if (piece instanceof List) {
      return this.escapeList(piece.values, options);
    }

    if (piece instanceof Value) {
      return this.escape(piece.value, options);
    }

    if (piece instanceof Identifier) {
      return this.quoteIdentifier(piece.value);
    }

    if (piece instanceof Cast) {
      return this.formatCast(piece, options);
    }

    if (piece instanceof Col) {
      return this.formatCol(piece, options);
    }

    if (piece instanceof Attribute) {
      return this.formatAttribute(piece, options);
    }

    if (piece instanceof Where) {
      if (piece.where instanceof PojoWhere) {
        return this.whereSqlBuilder.formatPojoWhere(piece.where, options);
      }

      return this.whereSqlBuilder.formatWhereOptions(piece.where, options);
    }

    if (piece instanceof JsonPath) {
      return this.formatJsonPath(piece, options);
    }

    if (piece instanceof AssociationPath) {
      return this.formatAssociationPath(piece);
    }

    return `${piece.constructor.name} TODO`;
  }

  protected formatAssociationPath(associationPath: AssociationPath): string {
    // !TODO: handle association alias for current query
    return `${this.quoteIdentifier(associationPath.associationPath.join('->'))}.${this.quoteIdentifier(associationPath.attribute)}`;
  }

  protected formatJsonPath(jsonPathVal: JsonPath, options?: FormatSequelizeMethodOptions): string {
    const value = this.escape(jsonPathVal.value, options);

    if (jsonPathVal.path.length === 0) {
      return value;
    }

    return this.jsonPathExtractionQuery2(value, jsonPathVal.path);
  }

  jsonPathExtractionQuery2(_value: string, _path: readonly string[]): string {
    if (!this.dialect.supports.jsonOperations) {
      throw new Error(`JSON operations are not supported in ${this.dialect.name}.`);
    }

    throw new Error(`jsonPathExtractionQuery not been implemented in ${this.dialect.name}.`);
  }

  protected formatLiteral(piece: Literal, options?: FormatSequelizeMethodOptions): string {
    const sql = piece.val.map(part => {
      if (part instanceof SequelizeMethod) {
        return this.formatSequelizeMethod(piece, options);
      }

      return part;
    }).join('');

    if (options?.replacements) {
      return injectReplacements(sql, this.dialect, options.replacements, {
        onPositionalReplacement: () => {
          throw new TypeError(`The following literal includes positional replacements (?).
Only named replacements (:name) are allowed in literal() because we cannot guarantee the order in which they will be evaluated:
➜ literal(${JSON.stringify(sql)})`);
        },
      });
    }

    return sql;
  }

  protected formatAttribute(piece: Attribute, options?: FormatSequelizeMethodOptions): string {
    const model = options?.model;

    // This handles special attribute syntaxes like $association.references$, json.paths, and attribute::casting
    const parsedAttributeName = parseAttributeSyntax(piece);
    if (!(parsedAttributeName instanceof Attribute)) {
      return this.formatSequelizeMethod(parsedAttributeName, options);
    }

    if (!model) {
      return this.quoteIdentifier(parsedAttributeName.attributeName);
    }

    const columnName = model.modelDefinition.getColumnNameLoose(parsedAttributeName.attributeName);

    return this.quoteIdentifier(columnName);
  }

  protected formatFn(piece: Fn, options?: Bindable): string {
    const args = piece.args.map(arg => {
      if (arg instanceof SequelizeMethod) {
        return this.formatSequelizeMethod(arg, options);
      }

      return this.escape(arg, options);
    }).join(', ');

    return `${piece.fn}(${args})`;
  }

  protected formatCast(cast: Cast, options?: FormatSequelizeMethodOptions) {
    const type = this.sequelize.normalizeDataType(cast.type);

    return `CAST(${this.escape(cast.val, options)} AS ${attributeTypeToSql(type).toUpperCase()})`;
  }

  protected formatCol(piece: Col, options?: FormatSequelizeMethodOptions) {
    // !TODO: can this be removed?
    if (piece.identifiers.length === 1 && piece.identifiers[0].startsWith('*')) {
      return '*';
    }

    // Weird legacy behavior
    const identifiers = piece.identifiers.length === 1 ? piece.identifiers[0] : piece.identifiers;

    // !TODO: use quoteIdentifiers?
    // @ts-expect-error -- quote is declared on child class
    return this.quote(identifiers, options?.model, undefined, options);
  }

  /**
   * Escapes a value (e.g. a string, number or date) as an SQL value (as opposed to an identifier).
   *
   * @param value The value to escape
   * @param options The options to use when escaping the value
   */
  escape(value: unknown, options: EscapeOptions = EMPTY_OBJECT): string {
    if (isPlainObject(value) && Op.col in value) {
      noOpCol();
      value = new Col(value[Op.col] as string);
    }

    if (value instanceof SequelizeMethod) {
      return this.formatSequelizeMethod(value, options);
    }

    if (value === undefined) {
      throw new TypeError('"undefined" cannot be escaped');
    }

    if (value === null) {
      // !TODO: There are cases in Db2 for i where 'NULL' isn't accepted, such as
      // comparison with a WHERE() statement. In those cases, we have to cast.
      // if (dialectName === 'ibmi' && format) {
      //   return 'cast(NULL as int)';
      // }

      if (options.bindParam) {
        return options.bindParam(null);
      }

      return 'NULL';
    }

    let { type } = options;
    if (type == null || typeof type === 'string') {
      type = bestGuessDataTypeOfVal(value, this.dialect);
    } else {
      type = this.sequelize.normalizeDataType(type);
    }

    this.validate(value, type);

    if (options.bindParam) {
      return type.getBindParamSql(value, options as BindParamOptions);
    }

    return type.escape(value);
  }

  /**
   * Validate a value against a field specification
   *
   * @param value The value to validate
   * @param type The DataType to validate against
   */
  validate(value: unknown, type: DataType) {
    if (this.sequelize.options.noTypeValidation || isNullish(value)) {
      return;
    }

    if (isString(type)) {
      return;
    }

    type = this.sequelize.normalizeDataType(type);

    const error = validateDataType(value, type);
    if (error) {
      throw error;
    }
  }

  /**
   * Escapes an array of values (e.g. strings, numbers or dates) as an SQL List of values.
   *
   * @param values The list of values to escape
   * @param options
   *
   * @example
   * ```ts
   * const values = [1, 2, 3];
   * queryGenerator.escapeList([1, 2, 3]); // '(1, 2, 3)'
   */
  escapeList(values: unknown[], options?: EscapeOptions): string {
    return `(${values.map(value => this.escape(value, options)).join(', ')})`;
  }
}

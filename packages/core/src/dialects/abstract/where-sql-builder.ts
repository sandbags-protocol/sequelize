import NodeUtil from 'node:util';
import type {
  ModelStatic,
  WhereOptions,
  WhereLeftOperand,
} from '../../index.js';
import { Op } from '../../operators';
import { parseAttributeSyntax } from '../../utils/attribute.js';
import { isPlainObject } from '../../utils/check.js';
import { noOpCol } from '../../utils/deprecations.js';
import { EMPTY_ARRAY, EMPTY_OBJECT } from '../../utils/object.js';
import { Attribute, JsonPath, SequelizeMethod, Col, Literal, Value, AssociationPath, Cast, Where } from '../../utils/sequelize-method.js';
import type { Nullish } from '../../utils/types.js';
import { getComplexKeys, getOperators } from '../../utils/where.js';
import type { NormalizedDataType } from './data-types.js';
import * as DataTypes from './data-types.js';
import { AbstractDataType } from './data-types.js';
import type { FormatWhereOptions } from './query-generator-typescript.js';
import type { AbstractQueryGenerator } from './query-generator.js';
import type { WhereAttributeHashValue } from './where-sql-builder-types.js';

export class PojoWhere {
  declare leftOperand: WhereLeftOperand;
  declare whereValue: WhereAttributeHashValue<any>;

  static create(
    leftOperand: WhereLeftOperand,
    whereAttributeHashValue: WhereAttributeHashValue<any>,
  ): PojoWhere {
    const pojoWhere = new PojoWhere();
    pojoWhere.leftOperand = leftOperand;
    pojoWhere.whereValue = whereAttributeHashValue;

    return pojoWhere;
  }
}

class ObjectPool<T> {
  #freeItems: T[];
  #factory: () => T;
  #lastOccupiedIndex: number;
  constructor(factory: () => T, initialSize: number) {
    this.#freeItems = Array.from({ length: initialSize }).map(factory);
    this.#lastOccupiedIndex = initialSize - 1;
    this.#factory = factory;
  }

  getObject(): T {
    if (this.#lastOccupiedIndex < 0) {
      return this.#factory();
    }

    return this.#freeItems[this.#lastOccupiedIndex--];
  }

  free(val: T): void {
    if (this.#lastOccupiedIndex >= (this.#freeItems.length - 1)) {
      this.#freeItems.push(val);

      return;
    }

    this.#freeItems[++this.#lastOccupiedIndex] = val;
  }
}

const pojoWherePool = new ObjectPool<PojoWhere>(() => new PojoWhere(), 20);

export class WhereSqlBuilder {
  readonly operatorMap: Record<symbol, string> = {
    [Op.eq]: '=',
    [Op.ne]: '!=',
    [Op.gte]: '>=',
    [Op.gt]: '>',
    [Op.lte]: '<=',
    [Op.lt]: '<',
    [Op.is]: 'IS',
    [Op.isNot]: 'IS NOT',
    [Op.in]: 'IN',
    [Op.notIn]: 'NOT IN',
    [Op.like]: 'LIKE',
    [Op.notLike]: 'NOT LIKE',
    [Op.iLike]: 'ILIKE',
    [Op.notILike]: 'NOT ILIKE',
    [Op.regexp]: '~',
    [Op.notRegexp]: '!~',
    [Op.iRegexp]: '~*',
    [Op.notIRegexp]: '!~*',
    [Op.between]: 'BETWEEN',
    [Op.notBetween]: 'NOT BETWEEN',
    [Op.overlap]: '&&',
    [Op.contains]: '@>',
    [Op.contained]: '<@',
    [Op.adjacent]: '-|-',
    [Op.strictLeft]: '<<',
    [Op.strictRight]: '>>',
    [Op.noExtendRight]: '&<',
    [Op.noExtendLeft]: '&>',
    [Op.any]: 'ANY',
    [Op.all]: 'ALL',
    [Op.match]: '@@',
    [Op.anyKeyExists]: '?|',
    [Op.allKeysExist]: '?&',
  };

  #jsonType: NormalizedDataType;
  #arrayOfTextType: NormalizedDataType;

  constructor(protected readonly queryGenerator: AbstractQueryGenerator) {
    this.#jsonType = new DataTypes.JSON().toDialectDataType(queryGenerator.dialect);
    this.#arrayOfTextType = new DataTypes.ARRAY(new DataTypes.TEXT()).toDialectDataType(queryGenerator.dialect);
  }

  protected get dialect() {
    return this.queryGenerator.dialect;
  }

  /**
   * Transforms any value accepted by {@link WhereOptions} into a SQL string.
   *
   * @param where
   * @param options
   */
  formatWhereOptions(
    where: WhereOptions,
    options: FormatWhereOptions = EMPTY_OBJECT,
  ): string {
    if (typeof where === 'string') {
      throw new TypeError('Support for `{ where: \'raw query\' }` has been removed. Use `{ where: literal(\'raw query\') }` instead');
    }

    try {
      return this.#handleRecursiveNotOrAndWithImplicitAndArray(where, (piece: PojoWhere | SequelizeMethod) => {
        if (piece instanceof SequelizeMethod) {
          return this.queryGenerator.formatSequelizeMethod(piece, options);
        }

        return this.formatPojoWhere(piece, options);
      });
    } catch (error) {
      throw new TypeError(`Invalid value received for the "where" option. Refer to the sequelize documentation to learn which values the "where" option accepts.\nValue: ${NodeUtil.inspect(where)}`, {
        cause: error,
      });
    }
  }

  /**
   * This is the recursive "and", "or" and "not" handler of the first level of {@link WhereOptions} (the level *before* encountering an attribute name).
   * Unlike handleRecursiveNotOrAndNestedPathRecursive, this method accepts arrays at the top level, which are implicitly converted to "and" groups.
   * and does not handle nested JSON paths.
   *
   * @param input
   * @param handlePart
   * @param logicalOperator AND / OR
   */
  #handleRecursiveNotOrAndWithImplicitAndArray<TAttributes>(
    input: WhereOptions<TAttributes>,
    handlePart: (part: SequelizeMethod | PojoWhere) => string,
    logicalOperator: typeof Op.and | typeof Op.or = Op.and,
  ): string {
    // Arrays in this method are treated as an implicit "AND" operator
    if (Array.isArray(input)) {
      return joinWithLogicalOperator(
        input.map(part => {
          if (part === undefined) {
            return '';
          }

          return this.#handleRecursiveNotOrAndWithImplicitAndArray(part, handlePart);
        }),
        logicalOperator,
      );
    }

    // if the input is not a plan object, then it can't include Operators.
    if (!isPlainObject(input)) {
      // @ts-expect-error -- This catches a scenario where the user did not respect the typing
      if (!(input instanceof SequelizeMethod)) {
        throw new TypeError(`Invalid Query: expected a plain object, an array or a sequelize SQL method but got ${NodeUtil.inspect(input)} `);
      }

      return handlePart(input);
    }

    const keys = getComplexKeys(input);

    const sqlArray = keys.map(operatorOrAttribute => {
      if (operatorOrAttribute === Op.not) {
        const generatedResult = this.#handleRecursiveNotOrAndWithImplicitAndArray(
          // @ts-expect-error -- This is a recursive type, which TS does not handle well
          input[Op.not] as WhereOptions<TAttributes>,
          handlePart,
        );

        return wrapWithNot(generatedResult);
      }

      if (operatorOrAttribute === Op.and || operatorOrAttribute === Op.or) {
        return this.#handleRecursiveNotOrAndWithImplicitAndArray(
          // @ts-expect-error -- This is a recursive type, which TS does not handle well
          input[operatorOrAttribute],
          handlePart,
          operatorOrAttribute as typeof Op.and | typeof Op.or,
        );
      }

      // it *has* to be an attribute now
      if (typeof operatorOrAttribute === 'symbol') {
        throw new TypeError(`Invalid Query: ${NodeUtil.inspect(input)} includes the Symbol Operator Op.${operatorOrAttribute.description} but only attributes, Op.and, Op.or, and Op.not are allowed.`);
      }

      let pojoWhereObject;
      try {
        pojoWhereObject = pojoWherePool.getObject();

        pojoWhereObject.leftOperand = new Attribute(operatorOrAttribute);

        // @ts-expect-error -- The type of "operatorOrAttribute" is too dynamic for TS
        pojoWhereObject.whereValue = input[operatorOrAttribute];

        return handlePart(pojoWhereObject);
      } finally {
        if (pojoWhereObject) {
          pojoWherePool.free(pojoWhereObject);
        }
      }
    });

    return joinWithLogicalOperator(sqlArray, logicalOperator);
  }

  /**
   * This method is responsible for transforming a group "left operand" + "operators, right operands" (multiple) into a SQL string.
   *
   * @param pojoWhere The representation of the group.
   * @param options Option bag.
   */
  formatPojoWhere(
    pojoWhere: PojoWhere,
    options: FormatWhereOptions = EMPTY_OBJECT,
  ): string {
    // we need to parse the left operand early to determine the data type of the right operand
    const leftPreJsonPath = pojoWhere.leftOperand instanceof Attribute
      ? parseAttributeSyntax(pojoWhere.leftOperand)
      : pojoWhere.leftOperand;

    let leftDataType = this.#getOperandType(leftPreJsonPath, options.model);
    const operandIsJsonColumn = leftDataType == null || leftDataType instanceof DataTypes.JSON;

    return this.#handleRecursiveNotOrAndNestedPathRecursive(
      leftPreJsonPath,
      pojoWhere.whereValue,
      operandIsJsonColumn,
      (left: WhereLeftOperand, operator: symbol | undefined, right: WhereLeftOperand) => {
        // "left" could have been wrapped in a JSON path. If we still don't know its data type, it's very likely a JSON column
        // if the user used a JSON path in the where clause.
        if (leftDataType == null && left instanceof JsonPath) {
          leftDataType = this.#jsonType;
        }

        if (operator === Op.col) {
          noOpCol();

          right = new Col(right as string);
          operator = Op.eq;
        }

        // This happens when the user does something like `where: { id: { [Op.any]: { id: 1 } } }`
        if (operator === Op.any || operator === Op.all) {
          right = { [operator]: right };
          operator = Op.eq;
        }

        if (operator == null) {
          operator = Array.isArray(right) && !(leftDataType instanceof DataTypes.ARRAY) ? Op.in
            : right === null ? Op.is
            : Op.eq;
        }

        // backwards compatibility
        if (right === null) {
          if (operator === Op.eq) {
            operator = Op.is;
          }

          if (operator === Op.ne) {
            operator = Op.isNot;
          }
        }

        right = right instanceof Attribute
          ? parseAttributeSyntax(right)
          : right;
        const rightDataType = this.#getOperandType(right, options.model);

        if (operator in this) {
          // @ts-expect-error -- TS does not know that this is a method
          return this[operator](left, leftDataType, operator, right, rightDataType, options);
        }

        return this.formatBinaryOperation(left, leftDataType, operator, right, rightDataType, options);
      },
    );
  }

  protected [Op.notIn](...args: Parameters<WhereSqlBuilder[typeof Op.in]>): string {
    return this[Op.in](...args);
  }

  protected [Op.in](
    left: WhereLeftOperand,
    leftDataType: NormalizedDataType | undefined,
    operator: symbol,
    right: WhereLeftOperand,
    rightDataType: NormalizedDataType | undefined,
    options: FormatWhereOptions,
  ): string {
    const rightEscapeOptions = { ...options, type: rightDataType ?? leftDataType };
    const leftEscapeOptions = { ...options, type: leftDataType ?? rightDataType };

    let rightSql: string;
    if (right instanceof Literal) {
      rightSql = this.queryGenerator.escape(right, rightEscapeOptions);
    } else if (Array.isArray(right)) {
      if (right.length === 0) {
        // NOT IN () does not exist in SQL, so we need to return a condition that is:
        // - always false if the operator is IN
        // - always true if the operator is NOT IN
        if (operator === Op.notIn) {
          return '';
        }

        rightSql = '(NULL)';
      } else {
        rightSql = this.queryGenerator.escapeList(right, rightEscapeOptions);
      }
    } else {
      throw new TypeError('Operators Op.in and Op.notIn must be called with an array of values, or a literal');
    }

    const leftSql = this.queryGenerator.escape(left, leftEscapeOptions);

    return `${leftSql} ${this.operatorMap[operator]} ${rightSql}`;
  }

  protected [Op.isNot](...args: Parameters<WhereSqlBuilder[typeof Op.is]>): string {
    return this[Op.is](...args);
  }

  protected [Op.is](
    left: WhereLeftOperand,
    leftDataType: NormalizedDataType | undefined,
    operator: symbol,
    right: WhereLeftOperand,
    rightDataType: NormalizedDataType | undefined,
    options: FormatWhereOptions,
  ): string {
    if (right !== null && typeof right !== 'boolean' && !(right instanceof Literal)) {
      throw new Error('Operators Op.is and Op.isNot can only be used with null, true, false or a literal.');
    }

    return this.formatBinaryOperation(left, leftDataType, operator, right, rightDataType, options);
  }

  protected [Op.notBetween](...args: Parameters<WhereSqlBuilder[typeof Op.between]>): string {
    return this[Op.between](...args);
  }

  protected [Op.between](
    left: WhereLeftOperand,
    leftDataType: NormalizedDataType | undefined,
    operator: symbol,
    right: WhereLeftOperand,
    rightDataType: NormalizedDataType | undefined,
    options: FormatWhereOptions,
  ): string {
    const rightEscapeOptions = { ...options, type: rightDataType ?? leftDataType };
    const leftEscapeOptions = { ...options, type: leftDataType ?? rightDataType };

    const leftSql = this.queryGenerator.escape(left, leftEscapeOptions);

    let rightSql: string;
    if (right instanceof SequelizeMethod) {
      rightSql = this.queryGenerator.escape(right, rightEscapeOptions);
    } else if (Array.isArray(right) && right.length === 2) {
      rightSql = `${this.queryGenerator.escape(right[0], rightEscapeOptions)} AND ${this.queryGenerator.escape(right[1], rightEscapeOptions)}`;
    } else {
      throw new Error('Operators Op.between and Op.notBetween must be used with an array of two values, or a literal.');
    }

    return `${leftSql} ${this.operatorMap[operator]} ${rightSql}`;
  }

  protected [Op.contains](
    left: WhereLeftOperand,
    leftDataType: NormalizedDataType | undefined,
    operator: symbol,
    right: WhereLeftOperand,
    rightDataType: NormalizedDataType | undefined,
    options: FormatWhereOptions,
  ): string {
    // In postgres, Op.contains has multiple signatures:
    // - RANGE<VALUE> Op.contains RANGE<VALUE> (both represented by fixed-size arrays in JS)
    // - RANGE<VALUE> Op.contains VALUE
    // - ARRAY<VALUE> Op.contains ARRAY<VALUE>
    // When the left operand is a range RANGE, we must be able to serialize the right operand as either a RANGE or a VALUE.
    if (!rightDataType && leftDataType instanceof DataTypes.RANGE && !Array.isArray(right)) {
      // This serializes the right operand as a VALUE
      return this.formatBinaryOperation(
        left,
        leftDataType,
        operator,
        right,
        leftDataType.options.subtype,
        options,
      );
    }

    // This serializes the right operand as a RANGE (or an array for ARRAY contains ARRAY)
    return this.formatBinaryOperation(left, leftDataType, operator, right, rightDataType, options);
  }

  protected [Op.contained](
    left: WhereLeftOperand,
    leftDataType: NormalizedDataType | undefined,
    operator: symbol,
    right: WhereLeftOperand,
    rightDataType: NormalizedDataType | undefined,
    options: FormatWhereOptions,
  ): string {
    // This function has the opposite semantics of Op.contains. It has the following signatures:
    // - RANGE<VALUE> Op.contained RANGE<VALUE> (both represented by fixed-size arrays in JS)
    // - VALUE Op.contained RANGE<VALUE>
    // - ARRAY<VALUE> Op.contained ARRAY<VALUE>

    // This serializes VALUE contained RANGE
    if (
      leftDataType instanceof AbstractDataType
      && !(leftDataType instanceof DataTypes.RANGE)
      && !(leftDataType instanceof DataTypes.ARRAY)
      && Array.isArray(right)
    ) {
      return this.formatBinaryOperation(
        left,
        leftDataType,
        operator,
        right,
        new DataTypes.RANGE(leftDataType).toDialectDataType(this.dialect),
        options,
      );
    }

    // This serializes:
    // RANGE contained RANGE
    // ARRAY contained ARRAY
    return this.formatBinaryOperation(left, leftDataType, operator, right, rightDataType, options);
  }

  protected [Op.startsWith](
    left: WhereLeftOperand,
    leftDataType: NormalizedDataType | undefined,
    operator: symbol,
    right: WhereLeftOperand,
    rightDataType: NormalizedDataType | undefined,
    options: FormatWhereOptions,
  ): string {
    return this.formatSubstring(left, leftDataType, Op.like, right, rightDataType, options, false, true);
  }

  protected [Op.notStartsWith](
    left: WhereLeftOperand,
    leftDataType: NormalizedDataType | undefined,
    operator: symbol,
    right: WhereLeftOperand,
    rightDataType: NormalizedDataType | undefined,
    options: FormatWhereOptions,
  ): string {
    return this.formatSubstring(left, leftDataType, Op.notLike, right, rightDataType, options, false, true);
  }

  protected [Op.endsWith](
    left: WhereLeftOperand,
    leftDataType: NormalizedDataType | undefined,
    operator: symbol,
    right: WhereLeftOperand,
    rightDataType: NormalizedDataType | undefined,
    options: FormatWhereOptions,
  ): string {
    return this.formatSubstring(left, leftDataType, Op.like, right, rightDataType, options, true, false);
  }

  protected [Op.notEndsWith](
    left: WhereLeftOperand,
    leftDataType: NormalizedDataType | undefined,
    operator: symbol,
    right: WhereLeftOperand,
    rightDataType: NormalizedDataType | undefined,
    options: FormatWhereOptions,
  ): string {
    return this.formatSubstring(left, leftDataType, Op.notLike, right, rightDataType, options, true, false);
  }

  protected [Op.substring](
    left: WhereLeftOperand,
    leftDataType: NormalizedDataType | undefined,
    operator: symbol,
    right: WhereLeftOperand,
    rightDataType: NormalizedDataType | undefined,
    options: FormatWhereOptions,
  ): string {
    return this.formatSubstring(left, leftDataType, Op.like, right, rightDataType, options, true, true);
  }

  protected [Op.notSubstring](
    left: WhereLeftOperand,
    leftDataType: NormalizedDataType | undefined,
    operator: symbol,
    right: WhereLeftOperand,
    rightDataType: NormalizedDataType | undefined,
    options: FormatWhereOptions,
  ): string {
    return this.formatSubstring(left, leftDataType, Op.notLike, right, rightDataType, options, true, true);
  }

  protected formatSubstring(
    left: WhereLeftOperand,
    leftDataType: NormalizedDataType | undefined,
    operator: symbol,
    right: WhereLeftOperand,
    rightDataType: NormalizedDataType | undefined,
    options: FormatWhereOptions,
    start: boolean,
    end: boolean,
  ) {
    if (typeof right === 'string') {
      const startToken = start ? '%' : '';
      const endToken = end ? '%' : '';

      return this.formatBinaryOperation(left, leftDataType, operator, startToken + right + endToken, rightDataType, options);
    }

    const escapedPercent = this.dialect.escapeString('%');
    const literalBuilder: Array<string | SequelizeMethod> = [`CONCAT(`];
    if (start) {
      literalBuilder.push(escapedPercent, ', ');
    }

    literalBuilder.push(new Value(right));

    if (end) {
      literalBuilder.push(', ', escapedPercent);
    }

    literalBuilder.push(')');

    return this.formatBinaryOperation(left, leftDataType, operator, new Literal(literalBuilder), rightDataType, options);
  }

  [Op.anyKeyExists](
    left: WhereLeftOperand,
    leftDataType: NormalizedDataType | undefined,
    operator: symbol,
    right: WhereLeftOperand,
    rightDataType: NormalizedDataType | undefined,
    options: FormatWhereOptions,
  ): string {
    return this.formatBinaryOperation(left, leftDataType, operator, right, this.#arrayOfTextType, options);
  }

  [Op.allKeysExist](
    left: WhereLeftOperand,
    leftDataType: NormalizedDataType | undefined,
    operator: symbol,
    right: WhereLeftOperand,
    rightDataType: NormalizedDataType | undefined,
    options: FormatWhereOptions,
  ): string {
    return this.formatBinaryOperation(left, leftDataType, operator, right, this.#arrayOfTextType, options);
  }

  protected formatBinaryOperation(
    left: WhereLeftOperand,
    leftDataType: NormalizedDataType | undefined,
    operator: symbol,
    right: WhereLeftOperand,
    rightDataType: NormalizedDataType | undefined,
    options: FormatWhereOptions,
  ) {
    const operatorSql = this.operatorMap[operator];
    if (!operatorSql) {
      throw new TypeError(`Operator Op.${operator.description} does not exist or is not supported by this dialect.`);
    }

    const leftSql = this.queryGenerator.escape(left, { ...options, type: leftDataType ?? rightDataType });
    const rightSql = this.#formatOpAnyAll(right, rightDataType ?? leftDataType)
      || this.queryGenerator.escape(right, { ...options, type: rightDataType ?? leftDataType });

    return `${wrapAmbiguousWhere(left, leftSql)} ${this.operatorMap[operator]} ${wrapAmbiguousWhere(right, rightSql)}`;
  }

  #formatOpAnyAll(value: unknown, type: NormalizedDataType | undefined): string {
    if (!isPlainObject(value)) {
      return '';
    }

    if (Op.any in value) {
      return `ANY (${this.#formatOpValues(value[Op.any], type)})`;
    }

    if (Op.all in value) {
      return `ALL (${this.#formatOpValues(value[Op.all], type)})`;
    }

    return '';
  }

  #formatOpValues(value: unknown, type: NormalizedDataType | undefined): string {
    if (isPlainObject(value) && Op.values in value) {
      const options = { type };

      const operand: unknown[] = Array.isArray(value[Op.values])
        ? value[Op.values] as unknown[]
        : [value[Op.values]];

      const valueSql = operand.map(v => `(${this.queryGenerator.escape(v, options)})`).join(', ');

      return `VALUES ${valueSql}`;
    }

    return this.queryGenerator.escape(value, { type: type && new DataTypes.ARRAY(type) });
  }

  /**
   * This is the recursive "and", "or" and "not" handler of {@link WhereAttributeHashValue} (the level *after* encountering an attribute name).
   * Unlike handleRecursiveNotOrAndWithImplicitAndArray, arrays at the top level have an implicit "IN" operator, instead of an implicit "AND" operator,
   * and this method handles nested JSON paths.
   *
   * @param leftOperand
   * @param whereValue
   * @param allowJsonPath
   * @param handlePart
   * @param operator
   * @param parentJsonPath
   */
  #handleRecursiveNotOrAndNestedPathRecursive(
    leftOperand: WhereLeftOperand,
    whereValue: WhereAttributeHashValue<any>,
    allowJsonPath: boolean,
    handlePart: (
      left: WhereLeftOperand,
      operator: symbol | undefined,
      right: WhereLeftOperand,
    ) => string,
    operator: typeof Op.and | typeof Op.or = Op.and,
    parentJsonPath: readonly string[] = EMPTY_ARRAY,
  ): string {
    if (!isPlainObject(whereValue)) {
      return handlePart(this.#wrapJsonPath(leftOperand, parentJsonPath), undefined, whereValue);
    }

    const stringKeys = Object.keys(whereValue);
    if (!allowJsonPath && stringKeys.length > 0) {
      return handlePart(this.#wrapJsonPath(leftOperand, parentJsonPath), undefined, whereValue as WhereLeftOperand);
    }

    const keys = [...stringKeys, ...getOperators(whereValue)];

    const parts: string[] = keys.map(key => {
      // @ts-expect-error -- this recursive type is too difficult for TS to handle
      const value = whereValue[key];

      // nested JSON path
      if (typeof key === 'string') {
        return this.#handleRecursiveNotOrAndNestedPathRecursive(
          leftOperand,
          value,
          allowJsonPath,
          handlePart,
          operator,
          [...parentJsonPath, key],
        );
      }

      if (key === Op.not) {
        return wrapWithNot(
          this.#handleRecursiveNotOrAndNestedPathRecursive(
            leftOperand,
            value,
            allowJsonPath,
            handlePart,
            Op.and,
            parentJsonPath,
          ),
        );
      }

      if (key === Op.and || key === Op.or) {
        if (Array.isArray(value)) {
          const sqlParts = value
            .map(v => this.#handleRecursiveNotOrAndNestedPathRecursive(
              leftOperand,
              v,
              allowJsonPath,
              handlePart,
              Op.and,
              parentJsonPath,
            ));

          return joinWithLogicalOperator(sqlParts, key as typeof Op.and | typeof Op.or);
        }

        return this.#handleRecursiveNotOrAndNestedPathRecursive(
          leftOperand,
          value,
          allowJsonPath,
          handlePart,
          key as typeof Op.and | typeof Op.or,
          parentJsonPath,
        );
      }

      return handlePart(this.#wrapJsonPath(leftOperand, parentJsonPath), key, value);
    });

    return joinWithLogicalOperator(parts, operator);
  }

  #wrapJsonPath(operand: WhereLeftOperand, jsonPath: readonly string[]): WhereLeftOperand {
    if (jsonPath.length === 0) {
      return operand;
    }

    // merge JSON paths
    if (operand instanceof JsonPath) {
      return new JsonPath(operand.value, [...operand.path, ...jsonPath]);
    }

    return new JsonPath(operand, jsonPath);
  }

  #getOperandType(operand: WhereLeftOperand, model: Nullish<ModelStatic>): NormalizedDataType | undefined {
    if (!model) {
      return undefined;
    }

    if (operand instanceof Cast) {
      // TODO: if operand.type is a string (= SQL Type), we look up a per-dialect mapping of SQL types to Sequelize types
      return this.dialect.sequelize.normalizeDataType(operand.type);
    }

    if (operand instanceof JsonPath) {
      // JsonPath can wrap Attributes
      // If the attribute is unknown and it's not casted, we default to JSON
      return this.#getOperandType(operand.value, model) ?? this.#jsonType;
    }

    if (operand instanceof AssociationPath) {
      const association = model.modelDefinition.getAssociation(operand.associationPath);

      if (!association) {
        return undefined;
      }

      return this.#getOperandType(operand.attribute, association.target);
    }

    if (operand instanceof Attribute) {
      return model.modelDefinition.attributes.get(operand.attributeName)?.type;
    }

    return undefined;
  }
}

function joinWithLogicalOperator(sqlArray: string[], operator: typeof Op.and | typeof Op.or): string {
  const operatorSql = operator === Op.and ? ' AND ' : ' OR ';

  sqlArray = sqlArray.filter(val => Boolean(val));

  if (sqlArray.length === 0) {
    return '';
  }

  if (sqlArray.length === 1) {
    return sqlArray[0];
  }

  return sqlArray.map(sql => {
    if (/ AND | OR /i.test(sql)) {
      return `(${sql})`;
    }

    return sql;
  }).join(operatorSql);
}

function wrapWithNot(sql: string): string {
  if (!sql) {
    return '';
  }

  if (sql.startsWith('(') && sql.endsWith(')')) {
    return `NOT ${sql}`;
  }

  return `NOT (${sql})`;
}

export function wrapAmbiguousWhere(operand: WhereLeftOperand, sql: string): string {
  // where() can produce ambiguous SQL when used as an operand:
  //
  // { booleanAttr: where(fn('lower', col('name')), Op.is, null) }
  // produces the ambiguous SQL:
  //   [booleanAttr] = lower([name]) IS NULL
  // which is better written as:
  //   [booleanAttr] = (lower([name]) IS NULL)
  if (operand instanceof Where && sql.includes(' ')) {
    return `(${sql})`;
  }

  return sql;
}

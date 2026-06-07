import {
  Anthropic,
  __export
} from "./chunk-G3JZSVBX.js";

// ../ai/src/alignment/featurePack.ts
function parseAcceptanceCriteria(description) {
  if (!description.trim()) return [];
  const lines = description.split("\n").map((l) => l.trim());
  const criteria = [];
  const bulletRe = /^(?:[-*•]|\d+[.):])\s+(.+)$/;
  let inAcSection = false;
  let index = 0;
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.match(/acceptance criteria|^ac:/)) {
      inAcSection = true;
      continue;
    }
    if (inAcSection && (line === "" || /^#+\s/.test(line))) {
      inAcSection = false;
    }
    const m = line.match(bulletRe);
    const mText = m?.[1];
    if (m && mText && (inAcSection || lower.startsWith("ac:"))) {
      criteria.push({ index, text: mText });
      index++;
    } else if (m && mText && inAcSection) {
      criteria.push({ index, text: mText });
      index++;
    }
  }
  if (criteria.length === 0) {
    for (const line of lines) {
      const m = line.match(bulletRe);
      const mText = m?.[1];
      if (m && mText) {
        criteria.push({ index, text: mText });
        index++;
      }
    }
  }
  return criteria;
}
function scoreHunkRelevance(hunkContent, criteria) {
  if (criteria.length === 0) return 0;
  const hunkTokens = tokenise(hunkContent);
  if (hunkTokens.size === 0) return 0;
  const criteriaTokens = /* @__PURE__ */ new Set();
  for (const c of criteria) {
    for (const t of tokenise(c.text)) criteriaTokens.add(t);
  }
  const intersection = [...hunkTokens].filter((t) => criteriaTokens.has(t)).length;
  const union = (/* @__PURE__ */ new Set([...hunkTokens, ...criteriaTokens])).size;
  return union === 0 ? 0 : intersection / union;
}
function tokenise(text) {
  const tokens = text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  return new Set(tokens);
}
function rankDiffHunks(rawHunks, criteria) {
  const ranked = rawHunks.map((h) => ({
    filePath: h.filePath,
    content: h.content,
    relevanceScore: scoreHunkRelevance(h.content, criteria)
  }));
  ranked.sort((a, b2) => b2.relevanceScore - a.relevanceScore);
  return ranked;
}
function buildAlignmentFeaturePack(params) {
  const criteria = parseAcceptanceCriteria(params.issueDescription);
  const diffHunks = rankDiffHunks(params.rawDiffHunks, criteria);
  return {
    issueKey: params.issueKey,
    issueType: params.issueType,
    issueSummary: params.issueSummary,
    issueDescription: params.issueDescription,
    criteria,
    prTitle: params.prTitle,
    prBody: params.prBody,
    commitMessages: params.commitMessages,
    diffHunks
  };
}

// ../ai/src/alignment/evidenceGuard.ts
var RELEVANCE_THRESHOLD = 0.05;
function applyEvidenceGuard(criteriaResults, allCriteria, diffHunks) {
  return criteriaResults.map((result) => {
    if (result.covered !== "yes") return result;
    if (!result.evidence.trim()) {
      return { ...result, covered: "unclear" };
    }
    const criterion = allCriteria.find((c) => c.index === result.index);
    if (!criterion) {
      return { ...result, covered: "unclear" };
    }
    const score = scoreHunkRelevance(result.evidence, [criterion]);
    if (score < RELEVANCE_THRESHOLD) {
      return { ...result, covered: "unclear" };
    }
    const matchesHunk = diffHunks.some(
      (h) => h.relevanceScore >= RELEVANCE_THRESHOLD && (h.content.includes(result.evidence.trim()) || result.evidence.trim().includes(h.content.trim().slice(0, 40)))
    );
    if (diffHunks.length > 0 && !matchesHunk) {
      return { ...result, covered: "unclear" };
    }
    return result;
  });
}
function computeCoverageRatio(guardedCriteria) {
  if (guardedCriteria.length === 0) return 0;
  const covered = guardedCriteria.filter((c) => c.covered === "yes").length;
  return covered / guardedCriteria.length;
}
function coverageRatioToOrdinal(ratio) {
  if (ratio <= 0) return "0";
  if (ratio < 0.25) return "1";
  if (ratio < 0.5) return "2";
  if (ratio < 0.75) return "3";
  return "4";
}
function applyMinRule(llmOrdinal, coverageOrdinal) {
  const n = Math.min(Number(llmOrdinal), Number(coverageOrdinal));
  return String(n);
}

// ../ai/src/prompts/registry.ts
var registry = /* @__PURE__ */ new Map();
function registryKey(insight, version) {
  return `${insight}@${version}`;
}
function registerPrompt(entry) {
  registry.set(registryKey(entry.insight, entry.version), entry);
}
function getPrompt(insight, version) {
  const entry = registry.get(registryKey(insight, version));
  if (!entry) {
    throw new Error(`Prompt not found: ${insight}@${version}`);
  }
  return entry;
}
function listPrompts() {
  return [...registry.values()].map((e) => ({ insight: e.insight, version: e.version }));
}

// ../../node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// ../../node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// ../../node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// ../../node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// ../../node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// ../../node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// ../../node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// ../../node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b2) {
  const aType = getParsedType(a);
  const bType = getParsedType(b2);
  if (a === b2) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b2);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b2 };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b2[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b2.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b2[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b2) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = /* @__PURE__ */ Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b2) {
    return new _ZodPipeline({
      in: a,
      out: b2,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: ((arg) => ZodString.create({ ...arg, coerce: true })),
  number: ((arg) => ZodNumber.create({ ...arg, coerce: true })),
  boolean: ((arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  })),
  bigint: ((arg) => ZodBigInt.create({ ...arg, coerce: true })),
  date: ((arg) => ZodDate.create({ ...arg, coerce: true }))
};
var NEVER = INVALID;

// ../ai/src/alignment/types.ts
var AlignmentOrdinal = external_exports.enum(["0", "1", "2", "3", "4"]);
var CoverageStatus = external_exports.enum(["yes", "no", "unclear"]);
var CoverageStatusEnum = CoverageStatus;
var CriterionCoverage = external_exports.object({
  /** Which criterion this covers (by index). */
  index: external_exports.number().int(),
  covered: CoverageStatus,
  /**
   * Quoted diff hunk that supports the claim.
   * Must be non-empty when covered === 'yes'.
   * Empty string / absent is acceptable for 'no' or 'unclear'.
   */
  evidence: external_exports.string()
});
var AlignmentLlmOutput = external_exports.object({
  /** Ordinal band 0–4, enum-encoded per §9.1.4. */
  ordinal: AlignmentOrdinal,
  /** Per-criterion coverage (one entry per criterion). */
  criteria: external_exports.array(CriterionCoverage),
  /**
   * Self-reported model confidence in [0, 1].
   * Used for audit; final score uses coverage_ratio cross-check.
   */
  confidence: external_exports.number()
});

// ../ai/src/alignment/prompt.ts
var ALIGNMENT_PROMPT_VERSION = "1.0.0";
var ALIGNMENT_SYSTEM_PROMPT = `You are a precise code-review assistant evaluating whether a pull request covers the acceptance criteria of its linked ticket.

Rules:
- Judge EACH criterion independently (pointwise \u2014 no pairwise comparison).
- "covered: yes" REQUIRES a verbatim quoted snippet from the diff that directly addresses the criterion.
- If you cannot find a directly relevant diff snippet, use "covered: unclear" or "covered: no".
- Quote ONLY text that appears in the provided diff hunks. Do not fabricate or paraphrase.
- Use "covered: unclear" for vague criteria or when evidence is ambiguous.
- Your ordinal band reflects the overall alignment: 0=none, 1=minimal, 2=partial, 3=mostly, 4=fully covered.
- Report confidence as a number in [0, 1].
`;
function buildAlignmentUserMessage(pack) {
  const criteriaBlock = pack.criteria.map((c) => `[${c.index}] ${c.text}`).join("\n");
  const hunksBlock = pack.diffHunks.map((h) => `--- ${h.filePath} (relevance=${h.relevanceScore.toFixed(3)})
${h.content}`).join("\n\n");
  const commits = pack.commitMessages.map((m) => `- ${m}`).join("\n");
  return `## Ticket: ${pack.issueKey} (${pack.issueType})
**Summary:** ${pack.issueSummary}

**Description:**
${pack.issueDescription}

## Acceptance Criteria
${criteriaBlock || "(none provided)"}

## Pull Request: ${pack.prTitle}
**Body:**
${pack.prBody || "(none)"}

**Commits:**
${commits || "(none)"}

## Diff Hunks (relevance-ranked)
${hunksBlock || "(no diff)"}

---
For EACH acceptance criterion above, output whether it is covered by the diff.
Return your answer as JSON matching the schema: { ordinal, criteria: [{index, covered, evidence}], confidence }.
`;
}
var alignmentOutputSchema = AlignmentLlmOutput;
registerPrompt({
  insight: "alignment",
  version: ALIGNMENT_PROMPT_VERSION,
  systemPrompt: ALIGNMENT_SYSTEM_PROMPT,
  // biome-ignore lint/suspicious/noExplicitAny: featureVector is typed as AlignmentFeaturePack at call sites
  userPromptTemplate: (fv) => buildAlignmentUserMessage(fv)
});

// ../ai/src/alignment/runAlignment.ts
import { createHash } from "node:crypto";

// ../ai/src/harness.ts
import { randomUUID } from "node:crypto";

// ../ai/src/constants.ts
var DEFAULT_MODEL = "claude-sonnet-4-6";
var ENSEMBLE_MODEL = "claude-opus-4-8";

// ../ai/src/requestShape.ts
function requestShape(modelId, opts = {}) {
  const isOpus = modelId.startsWith("claude-opus-");
  if (isOpus) {
    return {};
  }
  const shape = {};
  if (opts.temperature !== void 0) shape.temperature = opts.temperature;
  if (opts.topP !== void 0) shape.top_p = opts.topP;
  if (opts.topK !== void 0) shape.top_k = opts.topK;
  return shape;
}

// ../ai/src/harness.ts
async function runEnsemble(primary, options, client) {
  const ensembleModelId = ENSEMBLE_MODEL;
  const shape = requestShape(ensembleModelId, {});
  const result = await client.parse({
    model: ensembleModelId,
    max_tokens: options.maxTokens ?? 1024,
    messages: [{ role: "user", content: options.userMessage }],
    requestShape: shape,
    outputConfigFormat: options.outputConfigFormat
  });
  if (result.value === null) {
    return primary;
  }
  if (primary === null) {
    return result.value;
  }
  if (JSON.stringify(primary) === JSON.stringify(result.value)) {
    return primary;
  }
  return primary;
}
async function runVerdict(options, client, store, cache) {
  const modelId = options.modelId ?? DEFAULT_MODEL;
  const promptVersion = options.promptVersion;
  const cacheKey = {
    subjectType: options.subjectType,
    subjectId: options.subjectId,
    contentHash: options.contentHash,
    promptVersion,
    modelId
  };
  const cached = cache.get(cacheKey);
  if (cached) {
    return {
      verdict: cached,
      value: JSON.parse(cached.structuredVerdictJson),
      fromCache: true
    };
  }
  const shape = requestShape(modelId, options.samplingOpts ?? {});
  const result = await client.parse({
    model: modelId,
    max_tokens: options.maxTokens ?? 1024,
    messages: [{ role: "user", content: options.userMessage }],
    requestShape: shape,
    outputConfigFormat: options.outputConfigFormat
  });
  let finalValue = result.value;
  if (options.shouldEscalate?.(result.value)) {
    finalValue = await runEnsemble(result.value, options, client);
  }
  const now2 = (/* @__PURE__ */ new Date()).toISOString();
  const verdict = {
    id: randomUUID(),
    subjectType: options.subjectType,
    subjectId: options.subjectId,
    metric: options.metric,
    promptVersion,
    modelId,
    modelSnapshot: result.modelSnapshot,
    requestShape: JSON.stringify(result.requestShape),
    featureVectorJson: JSON.stringify(options.featureVector),
    structuredVerdictJson: JSON.stringify(finalValue),
    evidenceJson: JSON.stringify(extractEvidence(finalValue)),
    confidence: extractConfidence(finalValue),
    createdAt: now2,
    correctedBy: null,
    correctionJson: null
  };
  await store.insertAiVerdict(verdict);
  cache.set(cacheKey, verdict);
  return { verdict, value: finalValue, fromCache: false };
}
async function correctVerdict(id, correctedBy, correctionJson, store) {
  await store.correctAiVerdict(id, correctedBy, correctionJson);
}
function extractEvidence(value) {
  if (value !== null && typeof value === "object" && "evidence" in value) {
    return value.evidence;
  }
  return null;
}
function extractConfidence(value) {
  if (value !== null && typeof value === "object" && "confidence" in value) {
    const c = value.confidence;
    if (typeof c === "number") return c;
  }
  return 0;
}

// ../ai/src/alignment/runAlignment.ts
async function runAlignment(opts, client, store, cache) {
  const featurePack = buildAlignmentFeaturePack(opts.featurePackInput);
  const userMessage = buildAlignmentUserMessage(featurePack);
  const contentHash = createHash("sha256").update(JSON.stringify(featurePack)).digest("hex");
  const { value } = await runVerdict(
    {
      subjectType: "pull_request",
      subjectId: opts.prId,
      metric: "alignment",
      promptVersion: ALIGNMENT_PROMPT_VERSION,
      modelId: opts.modelId,
      maxTokens: 2048,
      contentHash,
      featureVector: featurePack,
      userMessage: `${ALIGNMENT_SYSTEM_PROMPT}

${userMessage}`,
      // biome-ignore lint/suspicious/noExplicitAny: outputConfigFormat is opaque any at the harness boundary
      outputConfigFormat: alignmentOutputSchema
    },
    client,
    store,
    cache
  );
  if (value === null) {
    return {
      result: {
        ordinal: "0",
        rawOrdinal: "0",
        criteria: [],
        coverageRatio: 0,
        confidence: 0
      },
      featurePack
    };
  }
  const guardedCriteria = applyEvidenceGuard(
    value.criteria,
    featurePack.criteria,
    featurePack.diffHunks
  );
  const coverageRatio = computeCoverageRatio(guardedCriteria);
  const coverageOrdinal = coverageRatioToOrdinal(coverageRatio);
  const finalOrdinal = applyMinRule(value.ordinal, coverageOrdinal);
  return {
    result: {
      ordinal: finalOrdinal,
      rawOrdinal: value.ordinal,
      criteria: guardedCriteria,
      coverageRatio,
      confidence: value.confidence
    },
    featurePack
  };
}

// ../ai/src/anomaly/detector.ts
var MIN_SAMPLE_SIZE = 8;
var EWMA_ALPHA = 0.3;
function computeEwmaZScore(series) {
  if (series.length < MIN_SAMPLE_SIZE) return null;
  let ewmaMean = series[0] ?? 0;
  let ewmaVar = 0;
  for (let i = 1; i < series.length - 1; i++) {
    const x = series[i] ?? 0;
    const delta = x - ewmaMean;
    ewmaMean = ewmaMean + EWMA_ALPHA * delta;
    ewmaVar = (1 - EWMA_ALPHA) * (ewmaVar + EWMA_ALPHA * delta * delta);
  }
  const ewmaStd = Math.sqrt(ewmaVar);
  if (ewmaStd === 0) return 0;
  const last = series[series.length - 1] ?? 0;
  return (last - ewmaMean) / ewmaStd;
}
function detectAnomaly(opts) {
  const { throughputSeries = [], cycleTimeSeries = [] } = opts;
  const tValues = throughputSeries.map((p) => p.throughput);
  const ctValues = cycleTimeSeries.map((p) => p.cycleTimeMedianSeconds);
  const hasEnoughThroughput = tValues.length >= MIN_SAMPLE_SIZE;
  const hasEnoughCycleTime = ctValues.length >= MIN_SAMPLE_SIZE;
  if (!hasEnoughThroughput && !hasEnoughCycleTime) {
    return {
      throughputZScore: null,
      cycleTimeZScore: null,
      isAnomaly: false,
      suppressedReason: `Insufficient sample: throughput n=${tValues.length}, cycle-time n=${ctValues.length}; minimum is ${MIN_SAMPLE_SIZE} each.`
    };
  }
  const throughputZScore = hasEnoughThroughput ? computeEwmaZScore(tValues) : null;
  const cycleTimeZScore = hasEnoughCycleTime ? computeEwmaZScore(ctValues) : null;
  const tAnomalous = throughputZScore !== null && Math.abs(throughputZScore) > 2;
  const ctAnomalous = cycleTimeZScore !== null && Math.abs(cycleTimeZScore) > 2;
  const isAnomaly = tAnomalous || ctAnomalous;
  return {
    throughputZScore,
    cycleTimeZScore,
    isAnomaly
  };
}

// ../ai/src/anomaly/types.ts
var AnomalyCause = external_exports.enum([
  "high_wip",
  "reviewer_latency",
  "blocked_issues",
  "ticket_churn",
  "team_size_change",
  "large_pr_overhead",
  "incident_response",
  "dependency_wait",
  "insufficient_signal"
]);
var RankedCause = external_exports.object({
  cause: AnomalyCause,
  /**
   * Self-reported likelihood in [0, 1].
   * Required even for 'insufficient_signal' (set to 0).
   */
  confidence: external_exports.number().min(0).max(1),
  /**
   * Which signal-pack field this cause is grounded in.
   * MUST name a key from AnomalySignalPack.
   * Required per SPEC — prevents invention.
   */
  evidence_pointer: external_exports.string()
});
var AnomalyLlmOutput = external_exports.object({
  /**
   * Causes ranked from most-likely to least-likely.
   * When the model cannot rank due to weak signals, emit a single entry
   * with cause='insufficient_signal'.
   */
  ranked_causes: external_exports.array(RankedCause).min(1),
  /** Free-form explanation phrased "consistent with", never "caused by". */
  summary: external_exports.string()
});

// ../ai/src/anomaly/prompt.ts
var ANOMALY_PROMPT_VERSION = "anomaly-v1";
var ANOMALY_SYSTEM_PROMPT = `You are an engineering-process analyst explaining a velocity anomaly to a team.

You are given a signal pack of systemic process indicators from the anomaly window.

Rules:
- Rank ONLY the candidate causes from the closed menu provided.
- Every ranked cause MUST include an evidence_pointer naming the specific signal-pack field that supports it.
- If the signals are too weak or ambiguous to rank causes, emit a single entry with cause='insufficient_signal'.
- NEVER attribute causes to an individual person, developer, or reviewer by name.
- Phrase the summary as "consistent with", never "caused by" or "proves" or "was caused by".
- Base rankings ONLY on the signal-pack values provided. Do not invent signals.
- Output confidence as a number in [0, 1] for each cause.
`;
function buildAnomalyUserMessage(pack) {
  return `## Signal Pack (anomaly window)

- avgWip: ${pack.avgWip.toFixed(1)} items
- reviewerLatencyHours: ${pack.reviewerLatencyHours.toFixed(1)} h
- blockedCount: ${pack.blockedCount} issues
- ticketChurnCount: ${pack.ticketChurnCount} re-opens / AC edits
- teamSizeDelta: ${pack.teamSizeDelta >= 0 ? "+" : ""}${pack.teamSizeDelta} members
- largePrShare: ${(pack.largePrShare * 100).toFixed(1)}%
- incidentCount: ${pack.incidentCount}
- dependencyWaitHours: ${pack.dependencyWaitHours.toFixed(1)} h
- throughputZScore: ${pack.throughputZScore !== null ? pack.throughputZScore.toFixed(2) : "n/a"}
- cycleTimeZScore: ${pack.cycleTimeZScore !== null ? pack.cycleTimeZScore.toFixed(2) : "n/a"}

## Candidate causes (closed menu \u2014 pick ONLY from this list)
- high_wip         \u2192 evidence_pointer: "avgWip"
- reviewer_latency \u2192 evidence_pointer: "reviewerLatencyHours"
- blocked_issues   \u2192 evidence_pointer: "blockedCount"
- ticket_churn     \u2192 evidence_pointer: "ticketChurnCount"
- team_size_change \u2192 evidence_pointer: "teamSizeDelta"
- large_pr_overhead\u2192 evidence_pointer: "largePrShare"
- incident_response\u2192 evidence_pointer: "incidentCount"
- dependency_wait  \u2192 evidence_pointer: "dependencyWaitHours"
- insufficient_signal \u2192 use when signals are too weak to rank

Rank the candidate causes from most-likely to least-likely, with a confidence and evidence_pointer per cause.
If signals are insufficient, return a single entry with cause='insufficient_signal', confidence=0, evidence_pointer='(none)'.

Return JSON matching: { ranked_causes: [{cause, confidence, evidence_pointer}], summary }
`;
}
var anomalyOutputSchema = AnomalyLlmOutput;
registerPrompt({
  insight: "anomaly",
  version: ANOMALY_PROMPT_VERSION,
  systemPrompt: ANOMALY_SYSTEM_PROMPT,
  userPromptTemplate: (pack) => buildAnomalyUserMessage(pack)
});

// ../ai/src/anomaly/runAnomaly.ts
import { createHash as createHash2 } from "node:crypto";
async function runAnomaly(opts, client, store, cache) {
  const detection = detectAnomaly({
    throughputSeries: opts.throughputSeries,
    cycleTimeSeries: opts.cycleTimeSeries
  });
  if (!detection.isAnomaly) {
    return { detection };
  }
  const userMessage = buildAnomalyUserMessage(opts.signalPack);
  const contentHash = createHash2("sha256").update(JSON.stringify(opts.signalPack)).digest("hex");
  const { value } = await runVerdict(
    {
      subjectType: "sprint",
      subjectId: opts.subjectId,
      metric: "anomaly",
      promptVersion: ANOMALY_PROMPT_VERSION,
      modelId: opts.modelId,
      maxTokens: 1024,
      contentHash,
      featureVector: opts.signalPack,
      userMessage: `${ANOMALY_SYSTEM_PROMPT}

${userMessage}`,
      // biome-ignore lint/suspicious/noExplicitAny: outputConfigFormat is opaque any at the harness boundary
      outputConfigFormat: anomalyOutputSchema
    },
    client,
    store,
    cache
  );
  if (value === null) {
    return { detection };
  }
  return {
    detection,
    rankedCauses: value.ranked_causes,
    summary: value.summary
  };
}

// ../ai/src/calibration/goldSet.ts
function extractCorrections(verdicts) {
  return verdicts.filter((v) => {
    return v.correctedBy !== null && v.correctionJson !== null;
  }).map((v) => ({
    id: v.id,
    subjectId: v.subjectId,
    metric: v.metric,
    correctionJson: v.correctionJson,
    correctedBy: v.correctedBy
  }));
}
function correctionsToGoldItems(corrections) {
  const items = [];
  for (const corr of corrections) {
    let parsed;
    try {
      parsed = JSON.parse(corr.correctionJson);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const labelField = parsed.label;
    if (typeof labelField !== "string" || labelField.length === 0) continue;
    items.push({
      subjectId: corr.subjectId,
      metric: corr.metric,
      humanLabel: labelField,
      raterId: corr.correctedBy
    });
  }
  return items;
}
function mergeGoldSets(staticItems, correctionItems) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const item of staticItems) {
    const key = `${item.metric}::${item.subjectId}::${item.raterId}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  for (const item of correctionItems) {
    const key = `${item.metric}::${item.subjectId}::${item.raterId}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}
function groupByMetric(items) {
  const map = /* @__PURE__ */ new Map();
  for (const item of items) {
    const existing = map.get(item.metric);
    if (existing) {
      existing.push(item);
    } else {
      map.set(item.metric, [item]);
    }
  }
  return map;
}
function extractHumanPairs(items) {
  const byRater = /* @__PURE__ */ new Map();
  for (const item of items) {
    let raterMap = byRater.get(item.raterId);
    if (!raterMap) {
      raterMap = /* @__PURE__ */ new Map();
      byRater.set(item.raterId, raterMap);
    }
    raterMap.set(item.subjectId, item.humanLabel);
  }
  const raterIds = Array.from(byRater.keys());
  if (raterIds.length < 2) return null;
  const raterAId = raterIds[0];
  const raterBId = raterIds[1];
  const mapA = byRater.get(raterAId);
  const mapB = byRater.get(raterBId);
  const sharedSubjects = [];
  for (const subjectId of mapA.keys()) {
    if (mapB.has(subjectId)) sharedSubjects.push(subjectId);
  }
  if (sharedSubjects.length === 0) return null;
  const raterA = sharedSubjects.map((s) => mapA.get(s));
  const raterB = sharedSubjects.map((s) => mapB.get(s));
  return { raterA, raterB };
}
function canonicalLabels(items) {
  const votes = /* @__PURE__ */ new Map();
  for (const item of items) {
    let v = votes.get(item.subjectId);
    if (!v) {
      v = /* @__PURE__ */ new Map();
      votes.set(item.subjectId, v);
    }
    v.set(item.humanLabel, (v.get(item.humanLabel) ?? 0) + 1);
  }
  const result = /* @__PURE__ */ new Map();
  for (const [subjectId, labelVotes] of votes) {
    let best = "";
    let bestCount = -1;
    for (const [label, count] of labelVotes) {
      if (count > bestCount) {
        best = label;
        bestCount = count;
      }
    }
    result.set(subjectId, best);
  }
  return result;
}
function extractPredictedLabel(verdict) {
  let parsed;
  try {
    parsed = JSON.parse(verdict.structuredVerdictJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed;
  for (const key of ["label", "ordinal", "band", "workType", "cause", "tier"]) {
    const v = obj[key];
    if (typeof v === "string") return v;
  }
  for (const v of Object.values(obj)) {
    if (typeof v === "string") return v;
  }
  return null;
}
function extractPredictedRank(verdict) {
  let parsed;
  try {
    parsed = JSON.parse(verdict.structuredVerdictJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed;
  for (const key of ["rank", "ordinal", "confidence"]) {
    const v = obj[key];
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}
async function loadCorrectedVerdicts(store, verdictIds) {
  const corrections = [];
  for (const id of verdictIds) {
    const v = await store.getAiVerdict(id);
    if (v && v.correctedBy !== null && v.correctionJson !== null) {
      corrections.push({
        id: v.id,
        subjectId: v.subjectId,
        metric: v.metric,
        correctionJson: v.correctionJson,
        correctedBy: v.correctedBy
      });
    }
  }
  return corrections;
}

// ../ai/src/calibration/metrics.ts
function cohenKappa(a, b2) {
  if (a.length !== b2.length) {
    throw new Error(`cohenKappa: arrays must have equal length (got ${a.length} vs ${b2.length})`);
  }
  const n = a.length;
  if (n === 0) return { kappa: 0, n: 0 };
  const labels = Array.from(/* @__PURE__ */ new Set([...a, ...b2]));
  const freqA = /* @__PURE__ */ new Map();
  const freqB = /* @__PURE__ */ new Map();
  for (const label of labels) {
    freqA.set(label, 0);
    freqB.set(label, 0);
  }
  let observed = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i];
    const bi = b2[i];
    if (ai === bi) observed++;
    freqA.set(ai, (freqA.get(ai) ?? 0) + 1);
    freqB.set(bi, (freqB.get(bi) ?? 0) + 1);
  }
  const po = observed / n;
  let pe = 0;
  for (const label of labels) {
    pe += (freqA.get(label) ?? 0) * (freqB.get(label) ?? 0) / (n * n);
  }
  if (pe >= 1) return { kappa: 1, n };
  return { kappa: (po - pe) / (1 - pe), n };
}
function macroF1(predicted, gold) {
  if (predicted.length !== gold.length) {
    throw new Error(
      `macroF1: arrays must have equal length (got ${predicted.length} vs ${gold.length})`
    );
  }
  if (predicted.length === 0) {
    return { macroF1: 0, perClass: [] };
  }
  const labels = Array.from(/* @__PURE__ */ new Set([...predicted, ...gold]));
  const perClass = labels.map((label) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let support = 0;
    for (let i = 0; i < gold.length; i++) {
      const g = gold[i];
      const p = predicted[i];
      if (g === label) support++;
      if (p === label && g === label) tp++;
      else if (p === label && g !== label) fp++;
      else if (p !== label && g === label) fn++;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
    return { label, precision, recall, f1, support };
  });
  const activeClasses = perClass.filter((c) => c.support > 0);
  const macro = activeClasses.length === 0 ? 0 : activeClasses.reduce((sum, c) => sum + c.f1, 0) / activeClasses.length;
  return { macroF1: macro, perClass };
}
function fractionalRanks(values) {
  const n = values.length;
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b2) => a.v - b2.v);
  const ranks = new Array(n).fill(0);
  let j = 0;
  while (j < n) {
    let k = j;
    while (k + 1 < n && (indexed[k + 1]?.v ?? NaN) === (indexed[j]?.v ?? NaN)) k++;
    const avgRank = (j + k) / 2 + 1;
    for (let m = j; m <= k; m++) {
      const entry = indexed[m];
      if (entry !== void 0) ranks[entry.i] = avgRank;
    }
    j = k + 1;
  }
  return ranks;
}
function spearmanRho(x, y) {
  if (x.length !== y.length) {
    throw new Error(`spearmanRho: arrays must have equal length (got ${x.length} vs ${y.length})`);
  }
  const n = x.length;
  if (n === 0) return { rho: 0, n: 0 };
  if (n === 1) return { rho: 1, n: 1 };
  const rx = fractionalRanks(x);
  const ry = fractionalRanks(y);
  const meanRx = rx.reduce((s, v) => s + v, 0) / n;
  const meanRy = ry.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dxi = rx[i] - meanRx;
    const dyi = ry[i] - meanRy;
    num += dxi * dyi;
    denX += dxi * dxi;
    denY += dyi * dyi;
  }
  if (denX === 0 || denY === 0) return { rho: 1, n };
  return { rho: num / Math.sqrt(denX * denY), n };
}
function computeEce(confidences, correct, numBins = 10) {
  if (confidences.length !== correct.length) {
    throw new Error(
      `computeEce: arrays must have equal length (got ${confidences.length} vs ${correct.length})`
    );
  }
  const n = confidences.length;
  if (n === 0) return { ece: 0, n: 0, bins: [] };
  const binSumConf = new Array(numBins).fill(0);
  const binSumCorr = new Array(numBins).fill(0);
  const binCount = new Array(numBins).fill(0);
  for (let i = 0; i < n; i++) {
    const conf = confidences[i];
    const isCorrect = correct[i];
    const binIdx = Math.min(Math.floor(conf * numBins), numBins - 1);
    binSumConf[binIdx] = (binSumConf[binIdx] ?? 0) + conf;
    binSumCorr[binIdx] = (binSumCorr[binIdx] ?? 0) + (isCorrect ? 1 : 0);
    binCount[binIdx] = (binCount[binIdx] ?? 0) + 1;
  }
  const bins = [];
  let ece = 0;
  for (let b2 = 0; b2 < numBins; b2++) {
    const count = binCount[b2] ?? 0;
    if (count === 0) continue;
    const avgConf = (binSumConf[b2] ?? 0) / count;
    const accuracy = (binSumCorr[b2] ?? 0) / count;
    const midpoint = (b2 + 0.5) / numBins;
    bins.push({ midpoint, avgConfidence: avgConf, accuracy, count });
    ece += count / n * Math.abs(accuracy - avgConf);
  }
  return { ece, n, bins };
}

// ../ai/src/calibration/report.ts
var KAPPA_FIXED_GATE = 0.6;
var MACRO_F1_GATE = 0.7;
function confidenceIsCalibrated(ece, threshold) {
  return ece <= threshold;
}
function buildInsightCalibration(metric, goldItems, verdicts, eceThreshold) {
  const canonical = canonicalLabels(goldItems);
  const verdictBySubject = /* @__PURE__ */ new Map();
  for (const v of verdicts) {
    const existing = verdictBySubject.get(v.subjectId);
    if (!existing || v.createdAt > existing.createdAt) {
      verdictBySubject.set(v.subjectId, v);
    }
  }
  const goldLabels = [];
  const predLabels = [];
  const goldRanks = [];
  const predRanks = [];
  const confidences = [];
  const isCorrect = [];
  for (const [subjectId, goldLabel] of canonical) {
    const verdict = verdictBySubject.get(subjectId);
    if (!verdict) continue;
    const predLabel = extractPredictedLabel(verdict);
    if (predLabel === null) continue;
    goldLabels.push(goldLabel);
    predLabels.push(predLabel);
    const goldNum = Number(goldLabel);
    const predNum = Number(predLabel);
    if (!Number.isNaN(goldNum) && !Number.isNaN(predNum)) {
      goldRanks.push(goldNum);
      predRanks.push(predNum);
    } else {
      const predRank = extractPredictedRank(verdict);
      const goldRank = goldRanks.length;
      if (predRank !== null) {
        goldRanks.push(goldRank);
        predRanks.push(predRank);
      }
    }
    const conf = verdict.confidence;
    if (conf !== null) {
      confidences.push(conf);
      isCorrect.push(predLabel === goldLabel);
    }
  }
  const modelKappa = goldLabels.length > 0 ? cohenKappa(goldLabels, predLabels) : { kappa: 0, n: 0 };
  const modelMacroF1 = goldLabels.length > 0 ? macroF1(predLabels, goldLabels) : { macroF1: 0, perClass: [] };
  const modelSpearman = goldRanks.length > 1 ? spearmanRho(goldRanks, predRanks) : { rho: 0, n: goldRanks.length };
  const humanPairs = extractHumanPairs(goldItems);
  const humanCeilingKappa = humanPairs !== null ? cohenKappa(humanPairs.raterA, humanPairs.raterB) : null;
  const passGate = humanCeilingKappa !== null ? Math.min(KAPPA_FIXED_GATE, humanCeilingKappa.kappa) : KAPPA_FIXED_GATE;
  const ece = confidences.length > 0 ? computeEce(confidences, isCorrect) : null;
  const calibrated = ece !== null ? confidenceIsCalibrated(ece.ece, eceThreshold) : false;
  return {
    metric,
    modelKappa,
    modelMacroF1,
    modelSpearman,
    humanCeilingKappa,
    passGate,
    kappaPass: modelKappa.kappa >= passGate,
    macroF1Pass: modelMacroF1.macroF1 >= MACRO_F1_GATE,
    ece,
    confidenceCalibrated: calibrated
  };
}
function buildCalibrationReport(options) {
  const { staticGoldItems, verdicts, eceThreshold = 0.1 } = options;
  const corrections = extractCorrections(verdicts);
  const correctionGoldItems = correctionsToGoldItems(corrections);
  const mergedGold = mergeGoldSets(staticGoldItems, correctionGoldItems);
  const goldByMetric = groupByMetric(mergedGold);
  const verdictsByMetric = /* @__PURE__ */ new Map();
  for (const v of verdicts) {
    const arr = verdictsByMetric.get(v.metric);
    if (arr) {
      arr.push(v);
    } else {
      verdictsByMetric.set(v.metric, [v]);
    }
  }
  const insights = [];
  for (const [metric, goldItems] of goldByMetric) {
    const metricVerdicts = verdictsByMetric.get(metric) ?? [];
    insights.push(buildInsightCalibration(metric, goldItems, metricVerdicts, eceThreshold));
  }
  const ensembleEligible = insights.length > 0 && insights.every((i) => i.confidenceCalibrated);
  return {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    insights,
    ensembleEligible
  };
}

// ../ai/src/classify/prior.ts
var CC_PREFIX_MAP = {
  feat: "feature",
  feature: "feature",
  fix: "bugfix",
  bug: "bugfix",
  bugfix: "bugfix",
  hotfix: "bugfix",
  refactor: "refactor",
  perf: "refactor",
  test: "test",
  tests: "test",
  docs: "docs",
  doc: "docs",
  chore: "chore",
  build: "chore",
  ci: "chore",
  style: "chore",
  revert: "chore",
  release: "chore",
  wip: "chore"
};
var CC_RE = /^([a-zA-Z]+)(?:\([^)]*\))?!?:\s/;
function classifyByConventionalCommit(message) {
  const m = message.trim().match(CC_RE);
  if (!m) return null;
  const rawPrefix = m[1];
  if (!rawPrefix) return null;
  const prefix = rawPrefix.toLowerCase();
  return CC_PREFIX_MAP[prefix] ?? null;
}
var PATH_PATTERNS = [
  // Test files
  { pattern: /\.(test|spec)\.[jt]sx?$/, workType: "test" },
  { pattern: /\/__tests__\//, workType: "test" },
  { pattern: /\/test\//, workType: "test" },
  { pattern: /\/tests\//, workType: "test" },
  { pattern: /\/e2e\//, workType: "test" },
  // Docs
  { pattern: /\.(md|mdx|rst|txt)$/i, workType: "docs" },
  { pattern: /\/docs?\//i, workType: "docs" },
  // Chore / infra
  { pattern: /^\.github\//, workType: "chore" },
  { pattern: /\/(ci|cd|infra|deploy|terraform|k8s)\//i, workType: "chore" },
  { pattern: /\.(yml|yaml|json|toml|lock)$/i, workType: "chore" },
  { pattern: /^Makefile$|^Dockerfile/i, workType: "chore" },
  { pattern: /package\.json$|package-lock\.json$/, workType: "chore" }
];
function classifyByPathPatterns(filePaths) {
  if (filePaths.length === 0) return null;
  const counts = /* @__PURE__ */ new Map();
  for (const p of filePaths) {
    for (const { pattern, workType } of PATH_PATTERNS) {
      if (pattern.test(p)) {
        counts.set(workType, (counts.get(workType) ?? 0) + 1);
        break;
      }
    }
  }
  if (counts.size === 0) return null;
  let best = null;
  let bestCount = 0;
  for (const [wt, count] of counts) {
    if (count > bestCount) {
      best = wt;
      bestCount = count;
    }
  }
  const ratio = bestCount / filePaths.length;
  return ratio > 0.5 ? best : null;
}
function applyDeterministicPrior(commitMessages, prTitle, filePaths) {
  const ccCounts = /* @__PURE__ */ new Map();
  for (const msg of [prTitle, ...commitMessages]) {
    const wt = classifyByConventionalCommit(msg);
    if (wt) ccCounts.set(wt, (ccCounts.get(wt) ?? 0) + 1);
  }
  if (ccCounts.size > 0) {
    let best = null;
    let bestCount = 0;
    for (const [wt, count] of ccCounts) {
      if (count > bestCount) {
        best = wt;
        bestCount = count;
      }
    }
    if (best) return { workType: best, source: "conventional_commit" };
  }
  const pathResult = classifyByPathPatterns(filePaths);
  if (pathResult) return { workType: pathResult, source: "path_pattern" };
  return null;
}

// ../ai/src/classify/prompt.ts
var CLASSIFY_PROMPT_VERSION = "1.0.0";
var CLASSIFY_SYSTEM_PROMPT = `You are a code-change classifier. Your task is to classify a pull request into exactly one work type.

Work types:
- feature    \u2014 new user-facing functionality
- bugfix     \u2014 fixing a defect or regression
- refactor   \u2014 code restructuring without behaviour change
- test       \u2014 adding or updating tests only
- docs       \u2014 documentation only
- chore      \u2014 build, CI, dependency, config, or tooling changes

Rules:
- Output ONLY one of the six work types above (no other values)
- Base your classification primarily on the diff content
- Report confidence as a number in [0, 1]
- Provide a one-sentence reasoning (for audit only)
`;
function buildClassifyUserMessage(params) {
  const commits = params.commitMessages.map((m) => `- ${m}`).join("\n");
  const paths = params.filePaths.slice(0, 50).join("\n");
  return `## PR: ${params.prTitle}
**Body:** ${params.prBody || "(none)"}

**Commits:**
${commits || "(none)"}

**Changed files (up to 50):**
${paths || "(none)"}

**Diff summary:**
${params.diffSummary || "(none)"}

Classify this PR into one work type. Return JSON: { workType, reasoning, confidence }.
`;
}
registerPrompt({
  insight: "classify",
  version: CLASSIFY_PROMPT_VERSION,
  systemPrompt: CLASSIFY_SYSTEM_PROMPT,
  // biome-ignore lint/suspicious/noExplicitAny: featureVector is typed as classify params at call sites
  userPromptTemplate: (fv) => buildClassifyUserMessage(fv)
});

// ../ai/src/classify/runClassify.ts
import { createHash as createHash3 } from "node:crypto";

// ../ai/src/classify/types.ts
var WorkType = external_exports.enum(["feature", "bugfix", "refactor", "test", "docs", "chore"]);
var ClassifyLlmOutput = external_exports.object({
  workType: WorkType,
  /** Short reasoning (one sentence, stored in audit). */
  reasoning: external_exports.string(),
  /** Model self-reported confidence in [0, 1]. */
  confidence: external_exports.number()
});
var PriorSource = external_exports.enum(["conventional_commit", "path_pattern", "llm", "blame_fallback"]);

// ../ai/src/classify/runClassify.ts
var _calibrationHook = null;
function registerCalibrationHook(hook) {
  _calibrationHook = hook;
}
async function runClassify(opts, client, store, cache) {
  const prior = applyDeterministicPrior(opts.commitMessages, opts.prTitle, opts.filePaths);
  if (prior) {
    const result2 = {
      workType: prior.workType,
      source: prior.source,
      confidence: 1,
      priorWorkType: prior.workType
    };
    _calibrationHook?.(result2);
    return result2;
  }
  const userMessage = buildClassifyUserMessage({
    prTitle: opts.prTitle,
    prBody: opts.prBody,
    commitMessages: opts.commitMessages,
    filePaths: opts.filePaths,
    diffSummary: opts.diffSummary
  });
  const contentHash = createHash3("sha256").update(
    JSON.stringify({
      prTitle: opts.prTitle,
      commitMessages: opts.commitMessages,
      filePaths: opts.filePaths,
      diffSummary: opts.diffSummary
    })
  ).digest("hex");
  const { value } = await runVerdict(
    {
      subjectType: opts.subjectType ?? "pull_request",
      subjectId: opts.subjectId,
      metric: "classify",
      promptVersion: CLASSIFY_PROMPT_VERSION,
      modelId: opts.modelId,
      maxTokens: 256,
      contentHash,
      featureVector: {
        prTitle: opts.prTitle,
        filePaths: opts.filePaths,
        commitCount: opts.commitMessages.length
      },
      userMessage: `${CLASSIFY_SYSTEM_PROMPT}

${userMessage}`,
      // biome-ignore lint/suspicious/noExplicitAny: outputConfigFormat is opaque any at the harness boundary
      outputConfigFormat: ClassifyLlmOutput
    },
    client,
    store,
    cache
  );
  if (value === null) {
    if (opts.blameFallback) {
      const result3 = {
        workType: opts.blameFallback,
        source: "blame_fallback",
        confidence: 0.5,
        priorWorkType: null
      };
      _calibrationHook?.(result3);
      return result3;
    }
    const result2 = {
      workType: "chore",
      source: "llm",
      confidence: 0,
      priorWorkType: null
    };
    _calibrationHook?.(result2);
    return result2;
  }
  const result = {
    workType: value.workType,
    source: "llm",
    confidence: value.confidence,
    priorWorkType: null
  };
  _calibrationHook?.(result);
  return result;
}

// ../ai/src/client/AnthropicLlmClient.ts
var AnthropicLlmClient = class {
  client;
  constructor(opts = {}) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
  }
  async parse(req) {
    const shape = requestShape(req.model, {
      temperature: req.requestShape.temperature,
      topP: req.requestShape.top_p,
      topK: req.requestShape.top_k
    });
    const createParams = {
      model: req.model,
      max_tokens: req.max_tokens,
      messages: req.messages,
      output_config: { format: req.outputConfigFormat }
    };
    if (shape.temperature !== void 0) createParams.temperature = shape.temperature;
    if (shape.top_p !== void 0) createParams.top_p = shape.top_p;
    if (shape.top_k !== void 0) createParams.top_k = shape.top_k;
    const response = await this.client.messages.parse(createParams);
    return {
      value: response.parsed_output ?? null,
      stopReason: response.stop_reason ?? null,
      modelSnapshot: response.model,
      requestShape: shape,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens
      }
    };
  }
};

// ../ai/src/client/FakeLlmClient.ts
var FakeLlmClient = class {
  queue;
  constructor(responses = []) {
    this.queue = [...responses];
  }
  reset(responses) {
    this.queue = [...responses];
  }
  async parse(req) {
    const next = this.queue.shift();
    if (!next) throw new Error("FakeLlmClient: no more queued responses");
    const fake = next;
    const shape = requestShape(req.model, {
      temperature: req.requestShape.temperature,
      topP: req.requestShape.top_p,
      topK: req.requestShape.top_k
    });
    const stopReason = fake.stopReason ?? (fake.value === null ? "refusal" : "end_turn");
    return {
      value: fake.value,
      stopReason,
      modelSnapshot: fake.modelSnapshot ?? `${req.model}-fake`,
      requestShape: shape,
      usage: { inputTokens: 0, outputTokens: 0 }
    };
  }
};

// ../ai/src/effort/prompt.ts
var EFFORT_PROMPT_VERSION = "1.0.0";
var EFFORT_SYSTEM_PROMPT = `You are an engineering-process analyst evaluating whether the effort for a pull request is proportionate to team norms.

You are given:
- An effort vector (HALOC, files, commits, cycle time, review rounds, comments, rework commits)
- A log-ratio: how many standard deviations the HALOC is from the team mean (in log space)
- A cycle-time z-score: how many standard deviations the cycle time is from the team mean
- The ticket scope text for context

Rules:
- Output ONLY an ordinal band: much_lower, lower, as_expected, higher, much_higher
- Do NOT produce a raw number or a precise estimate
- Base your band on the log-ratio and cycle-time z-score as primary signals
- Report confidence as a number in [0, 1]
- Never evaluate individual developers \u2014 this is a team-scope metric
- If signals conflict, favour the more conservative (less extreme) band
`;
function buildEffortUserMessage(params) {
  const spLine = params.storyPoints != null ? `Story points: ${params.storyPoints}` : "Story points: (not set)";
  return `## Effort Vector
- HALOC (canonical change units): ${params.vector.haloc}
- Files changed: ${params.vector.files}
- Commits: ${params.vector.commits}
- Cycle time: ${params.vector.cycleTime.toFixed(1)} hours
- Review rounds: ${params.vector.reviewRounds}
- Review comments: ${params.vector.comments}
- Rework commits: ${params.vector.reworkCommits}

## Deterministic Signals
- Log-ratio (HALOC vs team mean, std-dev units): ${params.logRatio.toFixed(3)}
- Cycle-time z-score: ${params.cycleTimeZScore.toFixed(3)}

## Ticket Context
- Issue type: ${params.issueType}
- Summary: ${params.issueSummary}
- ${spLine}

Based on the deterministic signals, output the effort band and your confidence.
`;
}
registerPrompt({
  insight: "effort",
  version: EFFORT_PROMPT_VERSION,
  systemPrompt: EFFORT_SYSTEM_PROMPT,
  // biome-ignore lint/suspicious/noExplicitAny: featureVector is typed as effort params at call sites
  userPromptTemplate: (fv) => buildEffortUserMessage(fv)
});

// ../ai/src/effort/runEffort.ts
import { createHash as createHash4 } from "node:crypto";

// ../ai/src/effort/types.ts
var EffortBand = external_exports.enum(["much_lower", "lower", "as_expected", "higher", "much_higher"]);
var INSUFFICIENT_HISTORY = "insufficient_history";
var EFFORT_MIN_HISTORY_N = 10;
var EXEMPT_ISSUE_TYPES = /* @__PURE__ */ new Set([
  "spike",
  "research",
  "Spike",
  "Research",
  "SPIKE",
  "RESEARCH",
  "Spke",
  // common typo
  "investigation",
  "Investigation"
]);
var EffortLlmOutput = external_exports.object({
  /** Ordinal band — enum, never a raw number. */
  band: EffortBand,
  /**
   * Free-text reasoning (short, one sentence).
   * Stored in the audit row; not surfaced to users.
   */
  reasoning: external_exports.string(),
  /** Model self-reported confidence in [0, 1]. */
  confidence: external_exports.number()
});

// ../ai/src/effort/stats.ts
function computeLogRatio(vector, dist) {
  if (dist.logHalocStd === 0) return null;
  const logHaloc = Math.log(vector.haloc + 1);
  return (logHaloc - dist.logHalocMean) / dist.logHalocStd;
}
function computeCycleTimeZScore(vector, dist) {
  if (dist.cycleTimeStd === 0) return null;
  return (vector.cycleTime - dist.cycleTimeMean) / dist.cycleTimeStd;
}
function zScoreToEffortBand(z) {
  if (z < -2) return "much_lower";
  if (z < -0.5) return "lower";
  if (z <= 0.5) return "as_expected";
  if (z <= 2) return "higher";
  return "much_higher";
}
function logRatioToEffortBand(logRatio) {
  return zScoreToEffortBand(logRatio);
}
function detectDisagreement(llmBand, deterministicBand) {
  const values = EffortBand.options;
  const llmIdx = values.indexOf(llmBand);
  const detIdx = values.indexOf(deterministicBand);
  return Math.abs(llmIdx - detIdx) > 1;
}
function adjustConfidenceForDisagreement(baseConfidence, llmBand, cycleTimeZScore) {
  if (cycleTimeZScore === null) return baseConfidence;
  const deterministicBand = zScoreToEffortBand(cycleTimeZScore);
  if (detectDisagreement(llmBand, deterministicBand)) {
    return Math.max(0, baseConfidence - 0.2);
  }
  return baseConfidence;
}

// ../ai/src/effort/runEffort.ts
async function runEffort(opts, client, store, cache) {
  if (opts.distribution.n < EFFORT_MIN_HISTORY_N) {
    return {
      band: INSUFFICIENT_HISTORY,
      logRatio: null,
      cycleTimeZScore: null,
      confidence: 0,
      exempt: false
    };
  }
  if (EXEMPT_ISSUE_TYPES.has(opts.issueType)) {
    return {
      band: INSUFFICIENT_HISTORY,
      logRatio: null,
      cycleTimeZScore: null,
      confidence: 0,
      exempt: true
    };
  }
  const logRatio = computeLogRatio(opts.vector, opts.distribution);
  const cycleTimeZScore = computeCycleTimeZScore(opts.vector, opts.distribution);
  if (logRatio === null || cycleTimeZScore === null) {
    return {
      band: INSUFFICIENT_HISTORY,
      logRatio,
      cycleTimeZScore,
      confidence: 0,
      exempt: false
    };
  }
  const userMessage = buildEffortUserMessage({
    vector: opts.vector,
    logRatio,
    cycleTimeZScore,
    issueSummary: opts.issueSummary,
    issueType: opts.issueType,
    storyPoints: opts.storyPoints
  });
  const contentHash = createHash4("sha256").update(
    JSON.stringify({ vector: opts.vector, dist: opts.distribution, issueType: opts.issueType })
  ).digest("hex");
  const { value } = await runVerdict(
    {
      subjectType: opts.subjectType ?? "pull_request",
      subjectId: opts.subjectId,
      metric: "effort",
      promptVersion: EFFORT_PROMPT_VERSION,
      modelId: opts.modelId,
      maxTokens: 512,
      contentHash,
      featureVector: {
        ...opts.vector,
        logRatio,
        cycleTimeZScore,
        issueType: opts.issueType,
        n: opts.distribution.n
      },
      userMessage: `${EFFORT_SYSTEM_PROMPT}

${userMessage}`,
      // biome-ignore lint/suspicious/noExplicitAny: outputConfigFormat is opaque any at the harness boundary
      outputConfigFormat: EffortLlmOutput
    },
    client,
    store,
    cache
  );
  if (value === null) {
    return {
      band: INSUFFICIENT_HISTORY,
      logRatio,
      cycleTimeZScore,
      confidence: 0,
      exempt: false
    };
  }
  const adjustedConfidence = adjustConfidenceForDisagreement(
    value.confidence,
    value.band,
    cycleTimeZScore
  );
  return {
    band: value.band,
    logRatio,
    cycleTimeZScore,
    confidence: adjustedConfidence,
    exempt: false
  };
}

// ../ai/src/impact/types.ts
var ImpactRationaleOutput = external_exports.object({
  /**
   * Human-readable rationale referencing actual changed paths.
   * Example: "touched auth middleware + a migration; high blast radius"
   * The LLM must cite the specific paths, NOT invent impact magnitude.
   */
  rationale: external_exports.string()
});

// ../ai/src/impact/prompt.ts
var IMPACT_PROMPT_VERSION = "impact-v1";
var IMPACT_SYSTEM_PROMPT = `You are a code-review assistant explaining why a code change has high or low blast radius.

You are given:
- The list of changed file paths
- Deterministic factor scores (editDiversity, halocNorm, fileCountNorm, changeEntropy, oldCodePct)
- The overall deterministic impact score

Rules:
- Your rationale MUST reference the ACTUAL changed paths provided.
- You explain the impact; you do NOT compute or change the score.
- Keep the rationale concise (1\u20132 sentences). Reference specific paths or path categories.
- Example: "touched src/auth/middleware.ts and 2 DB migrations; high blast radius due to auth + data layer changes"
- Do NOT invent paths, symbols, or files that are not in the provided list.
- Do NOT output a numeric score \u2014 the deterministic score is already computed.
`;
function buildImpactUserMessage(opts) {
  const paths = opts.filePaths.slice(0, 50).join("\n  ");
  const factorsStr = Object.entries(opts.factors).map(([k, v]) => `  ${k}: ${v.toFixed(3)}`).join("\n");
  const weightsStr = Object.entries(opts.weights).map(([k, v]) => `  ${k}: ${v}`).join("\n");
  return `## Changed paths (first 50)
  ${paths || "(none)"}

## HALOC
  ${opts.haloc}

## Deterministic factor scores
${factorsStr}

## Factor weights
${weightsStr}

## Overall impact score: ${opts.impactScore.toFixed(3)}

---
Write a 1\u20132 sentence rationale explaining WHY this change has this impact score.
Reference the ACTUAL changed paths above. Do not invent file names.
Return JSON: { rationale: "..." }
`;
}
var impactOutputSchema = ImpactRationaleOutput;
registerPrompt({
  insight: "impact",
  version: IMPACT_PROMPT_VERSION,
  systemPrompt: IMPACT_SYSTEM_PROMPT,
  userPromptTemplate: (opts) => buildImpactUserMessage(
    opts
  )
});

// ../ai/src/impact/runImpact.ts
import { createHash as createHash5 } from "node:crypto";

// ../core/src/constants.ts
var ENGINE_VERSION = "0.1.0";

// ../core/src/identity/bot.ts
var BOT_SUFFIXES = ["[bot]", "-bot", "_bot"];
var KNOWN_BOTS = /* @__PURE__ */ new Set([
  "dependabot",
  "renovate",
  "github-actions",
  "snyk-bot",
  "codecov",
  "sonarcloud",
  "deepsource-autofix",
  "allcontributors",
  "greenkeeper",
  "stale"
]);
function isGitHubBot(login, accountType, allowlist = []) {
  if (accountType === "Bot" || accountType === "Organization") return true;
  const lower = login.toLowerCase();
  for (const suffix of BOT_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  if (KNOWN_BOTS.has(lower)) return true;
  const lowerAllowlist = allowlist.map((s) => s.toLowerCase());
  if (lowerAllowlist.includes(lower)) return true;
  return false;
}
function isJiraBot(displayName, allowlist = []) {
  const lower = displayName.toLowerCase();
  for (const suffix of BOT_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  if (KNOWN_BOTS.has(lower)) return true;
  const lowerAllowlist = allowlist.map((s) => s.toLowerCase());
  if (lowerAllowlist.includes(lower)) return true;
  return false;
}

// ../core/src/identity/resolve.ts
function buildIdentityId(kind, externalId) {
  return `${kind}:${externalId}`;
}
function parseRawJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function extractCommitAuthorLogin(raw) {
  const parsed = parseRawJson(raw);
  const author = parsed.author;
  const login = author?.login;
  if (typeof login === "string" && login.length > 0) {
    return { login, type: author?.type };
  }
  return null;
}
function extractPrAuthorLogin(raw) {
  const parsed = parseRawJson(raw);
  const user = parsed.user;
  const login = user?.login;
  if (typeof login === "string" && login.length > 0) {
    return { login, type: user?.type };
  }
  return null;
}
function extractIssueAssignee(raw) {
  const parsed = parseRawJson(raw);
  const fields = parsed.fields;
  const assignee = fields?.assignee;
  if (!assignee) return null;
  const accountId = assignee.accountId;
  if (typeof accountId === "string" && accountId.length > 0) {
    return {
      accountId,
      displayName: assignee.displayName
    };
  }
  return null;
}
function buildGitHubLoginIdentity(login, accountType, now2, botAllowlist) {
  return {
    id: buildIdentityId("github_login", login),
    personId: null,
    kind: "github_login",
    externalId: login,
    isBot: isGitHubBot(login, accountType, botAllowlist),
    confidence: 1,
    raw: JSON.stringify({ login, type: accountType ?? "User" }),
    updatedAt: now2
  };
}
function buildJiraAccountIdentity(accountId, displayName, now2, botAllowlist) {
  return {
    id: buildIdentityId("jira_account", accountId),
    personId: null,
    kind: "jira_account",
    externalId: accountId,
    isBot: isJiraBot(displayName ?? "", botAllowlist),
    confidence: 1,
    raw: JSON.stringify({ accountId, displayName }),
    updatedAt: now2
  };
}
async function resolveIdentities(store, options = {}) {
  const now2 = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
  const botAllowlist = options.botAllowlist ?? [];
  let identitiesUpserted = 0;
  let issuesBackfilled = 0;
  let transitionsBackfilled = 0;
  async function upsertIdentity(identity) {
    await store.upsertIdentity(identity);
    identitiesUpserted++;
  }
  const orgs = await store.listOrganisations();
  for (const org of orgs) {
    const repos = await store.getRepositoriesByOrg(org.id);
    for (const repo of repos) {
      const commits = await store.getCommitsByRepo(repo.id);
      for (const commit of commits) {
        const loginInfo = extractCommitAuthorLogin(commit.raw);
        if (loginInfo) {
          await upsertIdentity(
            buildGitHubLoginIdentity(loginInfo.login, loginInfo.type, now2, botAllowlist)
          );
        }
      }
      const prs = await store.getPullRequestsByRepo(repo.id);
      for (const pr of prs) {
        const loginInfo = extractPrAuthorLogin(pr.raw);
        if (loginInfo) {
          await upsertIdentity(
            buildGitHubLoginIdentity(loginInfo.login, loginInfo.type, now2, botAllowlist)
          );
        }
      }
    }
  }
  const projects = await store.listJiraProjects();
  for (const project of projects) {
    const issues = await store.getIssuesByProject(project.id);
    for (const issue of issues) {
      if (issue.deletedAt) continue;
      const assigneeInfo = extractIssueAssignee(issue.raw);
      if (assigneeInfo) {
        const identity = buildJiraAccountIdentity(
          assigneeInfo.accountId,
          assigneeInfo.displayName,
          now2,
          botAllowlist
        );
        await upsertIdentity(identity);
        if (issue.assigneeIdentityId === null) {
          await store.setIssueAssigneeIdentity(issue.id, identity.id);
          issuesBackfilled++;
        }
      }
      const transitions = await store.getIssueTransitions(issue.id);
      for (const transition of transitions) {
        if (transition.actorIdentityId !== null) continue;
      }
      const actorMap = extractActorMapFromIssueRaw(issue.raw);
      if (actorMap.size > 0) {
        for (const transition of transitions) {
          if (transition.actorIdentityId !== null) continue;
          const actorInfo = actorMap.get(transition.transitionedAt);
          if (actorInfo) {
            const identity = buildJiraAccountIdentity(
              actorInfo.accountId,
              actorInfo.displayName,
              now2,
              botAllowlist
            );
            await upsertIdentity(identity);
            await store.setTransitionActorIdentity(transition.id, identity.id);
            transitionsBackfilled++;
          }
        }
      }
    }
  }
  return { identitiesUpserted, issuesBackfilled, transitionsBackfilled };
}
function extractActorMapFromIssueRaw(raw) {
  const map = /* @__PURE__ */ new Map();
  try {
    const parsed = JSON.parse(raw);
    const changelog = parsed.changelog;
    const histories = changelog?.histories;
    if (!histories) return map;
    for (const history of histories) {
      const created = history.created;
      if (!created) continue;
      const author = history.author;
      if (!author) continue;
      const accountId = author.accountId;
      if (!accountId) continue;
      map.set(created, {
        accountId,
        displayName: author.displayName
      });
    }
  } catch {
  }
  return map;
}

// ../core/src/identity/stitch.ts
import crypto from "node:crypto";
function newId() {
  return crypto.randomUUID();
}
function extractVerifiedEmail(raw) {
  try {
    const parsed = JSON.parse(raw);
    const email = parsed.email;
    if (typeof email !== "string" || !email.includes("@")) return null;
    if (email.endsWith("@users.noreply.github.com")) return null;
    return email.toLowerCase();
  } catch {
    return null;
  }
}
function localPart(email) {
  const idx = email.indexOf("@");
  if (idx <= 0) return null;
  return email.slice(0, idx).toLowerCase();
}
function normaliseName(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}
function namesAreSimilar(a, b2) {
  const tokensA = new Set(normaliseName(a).split(" ").filter(Boolean));
  const tokensB = new Set(normaliseName(b2).split(" ").filter(Boolean));
  let shared = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) shared++;
  }
  return shared >= 2;
}
function primaryAccountRef(identity) {
  if (identity.kind === "github_login") {
    try {
      const parsed = JSON.parse(identity.raw);
      const numericId = parsed.id;
      if (typeof numericId === "number") return `gh:${numericId}`;
    } catch {
    }
    return `gh:${identity.externalId}`;
  }
  if (identity.kind === "jira_account") {
    return `jira:${identity.externalId}`;
  }
  return null;
}
async function stitchPersons(store, options = {}) {
  const now2 = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
  let personsCreated = 0;
  let autoMerged = 0;
  let queued = 0;
  const identities = await store.listAllIdentities();
  const nonBots = identities.filter((id) => !id.isBot);
  for (const identity of nonBots) {
    if (identity.personId !== null) continue;
    const accountRef = primaryAccountRef(identity);
    if (!accountRef) continue;
    const person = {
      id: newId(),
      displayName: identity.externalId,
      // will be refined by later data
      primaryAccountRef: accountRef,
      updatedAt: now2
    };
    await store.upsertPerson(person);
    personsCreated++;
    await store.upsertIdentity({ ...identity, personId: person.id, updatedAt: now2 });
    autoMerged++;
  }
  const refreshed = await store.listAllIdentities();
  const nonBotRefreshed = refreshed.filter((id) => !id.isBot);
  const emailMap = /* @__PURE__ */ new Map();
  const verifiedEmailToPersonId = /* @__PURE__ */ new Map();
  for (const id of nonBotRefreshed) {
    if (id.kind === "commit_email") {
      emailMap.set(id.externalId.toLowerCase(), id);
    }
    if (id.kind === "github_login" && id.personId !== null) {
      const ve = extractVerifiedEmail(id.raw);
      if (ve) {
        verifiedEmailToPersonId.set(ve, id.personId);
      }
    }
  }
  for (const identity of nonBotRefreshed) {
    if (identity.kind !== "commit_email") continue;
    if (identity.personId !== null) continue;
    const email = identity.externalId.toLowerCase();
    const verifiedPersonId = verifiedEmailToPersonId.get(email);
    if (verifiedPersonId) {
      await store.upsertIdentity({ ...identity, personId: verifiedPersonId, updatedAt: now2 });
      autoMerged++;
      continue;
    }
    let mergedByJira = false;
    for (const other of nonBotRefreshed) {
      if (other.kind !== "jira_account") continue;
      if (other.personId === null) continue;
      try {
        const parsed = JSON.parse(other.raw);
        const jiraEmail = parsed.emailAddress?.toLowerCase();
        if (jiraEmail && jiraEmail === email) {
          await store.upsertIdentity({ ...identity, personId: other.personId, updatedAt: now2 });
          autoMerged++;
          mergedByJira = true;
          break;
        }
      } catch {
      }
    }
    if (mergedByJira) continue;
    const lp = localPart(email);
    let queued2c = false;
    if (lp) {
      for (const other of nonBotRefreshed) {
        if (other.id === identity.id) continue;
        if (other.kind !== "commit_email") continue;
        if (other.personId === null) continue;
        const otherEmail = other.externalId.toLowerCase();
        if (otherEmail === email) continue;
        const otherLp = localPart(otherEmail);
        if (otherLp !== lp) continue;
        await appendQueueEntry(store, identity, other, "local_part_name", 0.8, now2);
        queued++;
        queued2c = true;
        break;
      }
    }
    if (!queued2c) {
      for (const other of nonBotRefreshed) {
        if (other.id === identity.id) continue;
        if (other.personId === null) continue;
        const myName = nameFromIdentity(identity);
        const theirName = nameFromIdentity(other);
        if (!myName || !theirName) continue;
        if (namesAreSimilar(myName, theirName)) {
          await appendQueueEntry(store, identity, other, "fuzzy_name", 0.5, now2);
          queued++;
          break;
        }
      }
    }
  }
  const afterPass2 = await store.listAllIdentities();
  for (const identity of afterPass2) {
    if (identity.kind !== "github_login") continue;
    if (identity.personId !== null) continue;
    if (identity.isBot) continue;
    const ve = extractVerifiedEmail(identity.raw);
    if (!ve) continue;
    const emailIdentity = emailMap.get(ve);
    if (emailIdentity?.personId) {
      await store.upsertIdentity({
        ...identity,
        personId: emailIdentity.personId,
        updatedAt: now2
      });
      autoMerged++;
    }
  }
  return { personsCreated, autoMerged, queued };
}
function nameFromIdentity(identity) {
  try {
    const parsed = JSON.parse(identity.raw);
    const name = parsed.name ?? parsed.displayName ?? parsed.login;
    return name ?? null;
  } catch {
    return null;
  }
}
async function appendQueueEntry(store, a, b2, reason, confidence, now2) {
  const match = {
    id: newId(),
    identityIdA: a.id,
    identityIdB: b2.id,
    reason,
    confidence,
    status: "pending",
    decidedAt: null,
    decidedBy: null,
    createdAt: now2,
    updatedAt: now2
  };
  await store.appendCandidateMatch(match);
}

// ../core/src/linking/linkIssues.ts
var ISSUE_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
var SMART_COMMIT_RE = /\b([A-Z][A-Z0-9]+-\d+)\s+#(?:comment|time|done|close|resolve|transition)/gi;
function extractRegexKeys(text) {
  return [...text.matchAll(ISSUE_KEY_RE)].flatMap((m) => m[1] !== void 0 ? [m[1]] : []);
}
function extractSmartCommitKeys(text) {
  return [...text.matchAll(SMART_COMMIT_RE)].flatMap(
    (m) => m[1] !== void 0 ? [m[1].toUpperCase()] : []
  );
}
function extractBranchKeys(headRef) {
  return extractRegexKeys(headRef);
}
function parsePrRaw(raw) {
  try {
    const parsed = JSON.parse(raw);
    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      body: typeof parsed.body === "string" ? parsed.body : ""
    };
  } catch {
    return { title: "", body: "" };
  }
}
async function linkIssues(store, options = {}) {
  const at = options.now ?? (/* @__PURE__ */ new Date(864e13)).toISOString();
  let linksUpserted = 0;
  let falsePositivesDropped = 0;
  const orgs = await store.listOrganisations();
  for (const org of orgs) {
    const repos = await store.getRepositoriesByOrg(org.id);
    for (const repo of repos) {
      const prs = await store.getPullRequestsByRepo(repo.id);
      for (const pr of prs) {
        let addCandidate2 = function(key, source, confidence) {
          const existing = candidates.get(key);
          if (existing === void 0 || confidence > existing.confidence) {
            candidates.set(key, { source, confidence });
          }
        };
        var addCandidate = addCandidate2;
        if (pr.deletedAt) continue;
        const { title, body } = parsePrRaw(pr.raw);
        const headRef = pr.headRef;
        const commits = await store.getCommitsByRepo(repo.id);
        const candidates = /* @__PURE__ */ new Map();
        for (const key of extractSmartCommitKeys(`${title} ${body}`)) {
          addCandidate2(key, "smartcommit", 0.98);
        }
        for (const commit of commits) {
          for (const key of extractSmartCommitKeys(commit.raw)) {
            addCandidate2(key, "smartcommit", 0.95);
          }
        }
        for (const key of extractBranchKeys(headRef)) {
          addCandidate2(key, "branch", 0.85);
        }
        for (const key of extractRegexKeys(`${title} ${body}`)) {
          addCandidate2(key, "regex", 0.75);
        }
        for (const commit of commits) {
          const msg = typeof JSON.parse(commit.raw).commit === "object" ? JSON.parse(commit.raw).commit.message ?? commit.raw : commit.raw;
          for (const key of extractRegexKeys(msg)) {
            addCandidate2(key, "regex", 0.65);
          }
        }
        for (const [key, { source, confidence }] of candidates) {
          const issueId = await store.resolveIssueKey(key, at);
          if (issueId === null) {
            falsePositivesDropped++;
            continue;
          }
          const link = {
            prId: pr.id,
            issueId,
            linkSource: source,
            confidence
          };
          await store.upsertPrIssueLink(link);
          linksUpserted++;
        }
      }
    }
  }
  return { linksUpserted, falsePositivesDropped };
}

// ../core/src/migrate/migrations/0001_initial_schema.ts
var MIGRATION_0001_UP = (
  /* sql */
  `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Schema version tracking (also created by the runner, but idempotent here)
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER NOT NULL,
  applied_at  TEXT    NOT NULL,
  description TEXT    NOT NULL
);

-- GitHub / Jira organisations
CREATE TABLE IF NOT EXISTS organisations (
  id             TEXT NOT NULL PRIMARY KEY,
  github_login   TEXT,
  jira_cloud_id  TEXT,
  name           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Canonical persons, anchored on stable account ids
CREATE TABLE IF NOT EXISTS persons (
  id                  TEXT NOT NULL PRIMARY KEY,
  display_name        TEXT NOT NULL,
  primary_account_ref TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- Identity records linking platform accounts to persons
CREATE TABLE IF NOT EXISTS identities (
  id          TEXT    NOT NULL PRIMARY KEY,
  person_id   TEXT    REFERENCES persons(id),
  kind        TEXT    NOT NULL CHECK (kind IN ('github_login', 'commit_email', 'jira_account')),
  external_id TEXT    NOT NULL,
  is_bot      INTEGER NOT NULL DEFAULT 0,
  confidence  REAL    NOT NULL DEFAULT 1.0,
  raw         TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identities_person_id ON identities(person_id);
CREATE INDEX IF NOT EXISTS idx_identities_external ON identities(kind, external_id);

-- GitHub repositories; keyed on node_id to survive renames/transfers
CREATE TABLE IF NOT EXISTS repositories (
  id              TEXT    NOT NULL PRIMARY KEY,
  github_node_id  TEXT    NOT NULL UNIQUE,
  org_id          TEXT    NOT NULL REFERENCES organisations(id),
  owner           TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  default_branch  TEXT    NOT NULL,
  is_archived     INTEGER NOT NULL DEFAULT 0,
  is_fork         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  raw             TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repositories_org_id ON repositories(org_id);

-- Commits; composite PK (repo_id, sha)
CREATE TABLE IF NOT EXISTS commits (
  repo_id             TEXT    NOT NULL REFERENCES repositories(id),
  sha                 TEXT    NOT NULL,
  author_identity_id  TEXT    NOT NULL REFERENCES identities(id),
  authored_at         TEXT    NOT NULL,
  committed_at        TEXT    NOT NULL,
  additions           INTEGER NOT NULL DEFAULT 0,
  deletions           INTEGER NOT NULL DEFAULT 0,
  haloc               INTEGER NOT NULL DEFAULT 0,
  raw                 TEXT    NOT NULL,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  PRIMARY KEY (repo_id, sha)
);

CREATE INDEX IF NOT EXISTS idx_commits_authored_at ON commits(authored_at);

-- Co-author and trailer roles on commits
CREATE TABLE IF NOT EXISTS commit_authors (
  repo_id      TEXT NOT NULL,
  sha          TEXT NOT NULL,
  identity_id  TEXT NOT NULL REFERENCES identities(id),
  role         TEXT NOT NULL CHECK (role IN ('author', 'committer', 'co_author')),
  source       TEXT NOT NULL CHECK (source IN ('api', 'trailer')),
  PRIMARY KEY (repo_id, sha, identity_id, role),
  FOREIGN KEY (repo_id, sha) REFERENCES commits(repo_id, sha)
);

CREATE INDEX IF NOT EXISTS idx_commit_authors_identity ON commit_authors(identity_id);

-- Pull requests with denormalized stage timestamps
CREATE TABLE IF NOT EXISTS pull_requests (
  id                    TEXT    NOT NULL PRIMARY KEY,
  repo_id               TEXT    NOT NULL REFERENCES repositories(id),
  number                INTEGER NOT NULL,
  author_identity_id    TEXT    NOT NULL REFERENCES identities(id),
  state                 TEXT    NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
  head_ref              TEXT    NOT NULL,
  base_ref              TEXT    NOT NULL,
  is_draft              INTEGER NOT NULL DEFAULT 0,
  merged_via_queue      INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL,
  ready_at              TEXT,
  first_commit_at       TEXT,
  first_review_at       TEXT,
  approved_at           TEXT,
  merged_at             TEXT,
  merged_by_identity_id TEXT    REFERENCES identities(id),
  deleted_at            TEXT,
  raw                   TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pull_requests_repo_id ON pull_requests(repo_id);
CREATE INDEX IF NOT EXISTS idx_pull_requests_created_at ON pull_requests(created_at);

-- Reviews; keyed on GraphQL node_id
CREATE TABLE IF NOT EXISTS reviews (
  node_id              TEXT NOT NULL PRIMARY KEY,
  pr_id                TEXT NOT NULL REFERENCES pull_requests(id),
  reviewer_identity_id TEXT NOT NULL REFERENCES identities(id),
  state                TEXT NOT NULL CHECK (state IN ('approved', 'changes_requested', 'commented', 'dismissed', 'pending')),
  submitted_at         TEXT NOT NULL,
  raw                  TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_pr_id ON reviews(pr_id);

-- Review comments; keyed on GraphQL node_id
CREATE TABLE IF NOT EXISTS review_comments (
  node_id            TEXT NOT NULL PRIMARY KEY,
  pr_id              TEXT NOT NULL REFERENCES pull_requests(id),
  author_identity_id TEXT NOT NULL REFERENCES identities(id),
  created_at         TEXT NOT NULL,
  in_reply_to        TEXT,
  path               TEXT,
  raw                TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_comments_pr_id ON review_comments(pr_id);

-- Check runs for CI health
CREATE TABLE IF NOT EXISTS check_runs (
  node_id      TEXT NOT NULL PRIMARY KEY,
  repo_id      TEXT NOT NULL REFERENCES repositories(id),
  head_sha     TEXT NOT NULL,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL,
  conclusion   TEXT,
  started_at   TEXT,
  completed_at TEXT,
  raw          TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_check_runs_repo_head ON check_runs(repo_id, head_sha);

-- Deployments with source priority chain
CREATE TABLE IF NOT EXISTS deployments (
  id           TEXT NOT NULL PRIMARY KEY,
  repo_id      TEXT NOT NULL REFERENCES repositories(id),
  sha          TEXT NOT NULL,
  environment  TEXT NOT NULL,
  status       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  finished_at  TEXT,
  source       TEXT NOT NULL CHECK (source IN ('deployments_api', 'release', 'workflow', 'merge_proxy')),
  raw          TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deployments_repo_created ON deployments(repo_id, created_at);

-- Jira projects
CREATE TABLE IF NOT EXISTS jira_projects (
  id             TEXT NOT NULL PRIMARY KEY,
  key            TEXT NOT NULL,
  name           TEXT NOT NULL,
  jira_cloud_id  TEXT NOT NULL,
  raw            TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Jira issues with hierarchy and story-point provenance
CREATE TABLE IF NOT EXISTS issues (
  id                     TEXT    NOT NULL PRIMARY KEY,
  project_id             TEXT    NOT NULL REFERENCES jira_projects(id),
  key                    TEXT    NOT NULL,
  type                   TEXT    NOT NULL,
  status_id              TEXT    NOT NULL,
  status_category        TEXT    NOT NULL CHECK (status_category IN ('new', 'indeterminate', 'done')),
  story_points           REAL,
  story_points_field_id  TEXT,
  story_points_raw       TEXT,
  parent_id              TEXT    REFERENCES issues(id),
  epic_key               TEXT,
  is_subtask             INTEGER NOT NULL DEFAULT 0,
  hierarchy_level        INTEGER NOT NULL DEFAULT 1,
  assignee_identity_id   TEXT    REFERENCES identities(id),
  created_at             TEXT    NOT NULL,
  resolved_at            TEXT,
  deleted_at             TEXT,
  raw                    TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issues_project_id ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_status_id ON issues(status_id);

-- Issue key history for project moves
CREATE TABLE IF NOT EXISTS issue_keys (
  issue_id    TEXT NOT NULL REFERENCES issues(id),
  key         TEXT NOT NULL,
  valid_from  TEXT NOT NULL,
  valid_to    TEXT,
  PRIMARY KEY (issue_id, key)
);

CREATE INDEX IF NOT EXISTS idx_issue_keys_key ON issue_keys(key);

-- Append-only issue transitions; keystone for all flow metrics
CREATE TABLE IF NOT EXISTS issue_transitions (
  id                       TEXT NOT NULL PRIMARY KEY,
  issue_id                 TEXT NOT NULL REFERENCES issues(id),
  from_status_id           TEXT NOT NULL,
  to_status_id             TEXT NOT NULL,
  project_id_at_transition TEXT NOT NULL,
  transitioned_at          TEXT NOT NULL,
  actor_identity_id        TEXT REFERENCES identities(id)
);

CREATE INDEX IF NOT EXISTS idx_issue_transitions_issue_id ON issue_transitions(issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_transitions_transitioned_at ON issue_transitions(transitioned_at);

-- Sprints
CREATE TABLE IF NOT EXISTS sprints (
  id           TEXT NOT NULL PRIMARY KEY,
  board_id     TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('active', 'closed', 'future')),
  start_at     TEXT,
  end_at       TEXT,
  complete_at  TEXT,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sprints_board_id ON sprints(board_id);

-- Sprint membership events; replaces v1 boolean sprint_issues
CREATE TABLE IF NOT EXISTS sprint_membership_events (
  sprint_id           TEXT    NOT NULL REFERENCES sprints(id),
  issue_id            TEXT    NOT NULL REFERENCES issues(id),
  change              TEXT    NOT NULL CHECK (change IN ('added', 'removed')),
  points_at_event     REAL,
  transitioned_at     TEXT    NOT NULL,
  was_present_at_start INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sprint_membership_sprint ON sprint_membership_events(sprint_id);
CREATE INDEX IF NOT EXISTS idx_sprint_membership_issue ON sprint_membership_events(issue_id);

-- Board configuration; defines cycle-time start boundary
CREATE TABLE IF NOT EXISTS board_configs (
  board_id   TEXT NOT NULL PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('scrum', 'kanban')),
  updated_at TEXT NOT NULL
);

-- Board column definitions with started/done boundaries
CREATE TABLE IF NOT EXISTS board_columns (
  board_id       TEXT    NOT NULL REFERENCES board_configs(board_id),
  column_name    TEXT    NOT NULL,
  status_ids     TEXT    NOT NULL,
  is_started_col INTEGER NOT NULL DEFAULT 0,
  is_done_col    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (board_id, column_name)
);

-- Jira workflows; resolves the orphan FK on flow_state_models
CREATE TABLE IF NOT EXISTS workflows (
  workflow_id  TEXT NOT NULL PRIMARY KEY,
  name         TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Workflow scheme mappings; issue\u2192(project,issuetype)\u2192workflow_id
CREATE TABLE IF NOT EXISTS workflow_scheme_mappings (
  project_id   TEXT NOT NULL REFERENCES jira_projects(id),
  issue_type   TEXT NOT NULL,
  workflow_id  TEXT NOT NULL REFERENCES workflows(workflow_id),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, issue_type)
);

-- Teams; required for team/org scope rollups
CREATE TABLE IF NOT EXISTS teams (
  id         TEXT NOT NULL PRIMARY KEY,
  name       TEXT NOT NULL,
  org_id     TEXT NOT NULL REFERENCES organisations(id),
  updated_at TEXT NOT NULL
);

-- Effective-dated team membership
CREATE TABLE IF NOT EXISTS team_membership (
  team_id    TEXT NOT NULL REFERENCES teams(id),
  person_id  TEXT NOT NULL REFERENCES persons(id),
  valid_from TEXT NOT NULL,
  valid_to   TEXT,
  PRIMARY KEY (team_id, person_id, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_team_membership_person ON team_membership(person_id);

-- GitHub\u2194Jira issue linkage
CREATE TABLE IF NOT EXISTS pr_issue_links (
  pr_id        TEXT NOT NULL REFERENCES pull_requests(id),
  issue_id     TEXT NOT NULL REFERENCES issues(id),
  link_source  TEXT NOT NULL CHECK (link_source IN ('regex', 'smartcommit', 'branch', 'llm')),
  confidence   REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (pr_id, issue_id, link_source)
);

CREATE INDEX IF NOT EXISTS idx_pr_issue_links_issue ON pr_issue_links(issue_id);

-- Versioned daily metric snapshots
CREATE TABLE IF NOT EXISTS metric_snapshots (
  scope_type               TEXT    NOT NULL CHECK (scope_type IN ('repo', 'team', 'org', 'person', 'self')),
  scope_id                 TEXT    NOT NULL,
  metric                   TEXT    NOT NULL,
  day                      TEXT    NOT NULL,
  value                    REAL,
  window                   TEXT    NOT NULL,
  trust_tier               TEXT    NOT NULL CHECK (trust_tier IN ('deterministic', 'hybrid', 'probabilistic')),
  data_quality             TEXT    NOT NULL,
  engine_version           TEXT    NOT NULL,
  ingest_watermark_version TEXT    NOT NULL,
  coverage_fingerprint     TEXT    NOT NULL,
  computed_at              TEXT    NOT NULL,
  is_stale                 INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_type, scope_id, metric, day, ingest_watermark_version)
);

CREATE INDEX IF NOT EXISTS idx_metric_snapshots_scope ON metric_snapshots(scope_type, scope_id, metric);
CREATE INDEX IF NOT EXISTS idx_metric_snapshots_day ON metric_snapshots(day);

-- AI verdict audit trail
CREATE TABLE IF NOT EXISTS ai_verdicts (
  id                      TEXT NOT NULL PRIMARY KEY,
  subject_type            TEXT NOT NULL,
  subject_id              TEXT NOT NULL,
  metric                  TEXT NOT NULL,
  prompt_version          TEXT NOT NULL,
  model_id                TEXT NOT NULL,
  model_snapshot          TEXT NOT NULL,
  request_shape           TEXT NOT NULL,
  feature_vector_json     TEXT NOT NULL,
  structured_verdict_json TEXT NOT NULL,
  evidence_json           TEXT NOT NULL,
  confidence              REAL NOT NULL,
  created_at              TEXT NOT NULL,
  corrected_by            TEXT,
  correction_json         TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_verdicts_subject ON ai_verdicts(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_ai_verdicts_metric ON ai_verdicts(metric, created_at);

-- Per-workflow active/wait/done map; effective-dated
CREATE TABLE IF NOT EXISTS flow_state_models (
  workflow_id   TEXT NOT NULL REFERENCES workflows(workflow_id),
  status_id     TEXT NOT NULL,
  flow_state    TEXT NOT NULL CHECK (flow_state IN ('new', 'active', 'wait', 'done')),
  confidence    REAL NOT NULL DEFAULT 1.0,
  confirmed_by  TEXT REFERENCES identities(id),
  confirmed_at  TEXT,
  valid_from    TEXT NOT NULL,
  valid_to      TEXT,
  PRIMARY KEY (workflow_id, status_id, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_flow_state_models_workflow ON flow_state_models(workflow_id, status_id);

-- Jira status/category history; snapshotted at ingest for effective-dated replay
CREATE TABLE IF NOT EXISTS status_category_history (
  status_id   TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('new', 'indeterminate', 'done')),
  valid_from  TEXT NOT NULL,
  valid_to    TEXT,
  PRIMARY KEY (status_id, valid_from)
);

-- Per-resource sync state cursors and watermarks
CREATE TABLE IF NOT EXISTS sync_state (
  source       TEXT NOT NULL,
  resource     TEXT NOT NULL,
  scope_id     TEXT NOT NULL,
  cursor       TEXT,
  watermark_at TEXT,
  last_run_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'error')),
  error        TEXT,
  PRIMARY KEY (source, resource, scope_id)
);
`
);
var MIGRATION_0001_DOWN = (
  /* sql */
  `
DROP TABLE IF EXISTS sync_state;
DROP TABLE IF EXISTS status_category_history;
DROP TABLE IF EXISTS flow_state_models;
DROP TABLE IF EXISTS ai_verdicts;
DROP TABLE IF EXISTS metric_snapshots;
DROP TABLE IF EXISTS pr_issue_links;
DROP TABLE IF EXISTS team_membership;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS workflow_scheme_mappings;
DROP TABLE IF EXISTS workflows;
DROP TABLE IF EXISTS board_columns;
DROP TABLE IF EXISTS board_configs;
DROP TABLE IF EXISTS sprint_membership_events;
DROP TABLE IF EXISTS sprints;
DROP TABLE IF EXISTS issue_transitions;
DROP TABLE IF EXISTS issue_keys;
DROP TABLE IF EXISTS issues;
DROP TABLE IF EXISTS jira_projects;
DROP TABLE IF EXISTS deployments;
DROP TABLE IF EXISTS check_runs;
DROP TABLE IF EXISTS review_comments;
DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS pull_requests;
DROP TABLE IF EXISTS commit_authors;
DROP TABLE IF EXISTS commits;
DROP TABLE IF EXISTS repositories;
DROP TABLE IF EXISTS identities;
DROP TABLE IF EXISTS persons;
DROP TABLE IF EXISTS organisations;
`
);

// ../core/src/migrate/migrations/0002_candidate_matches.ts
var MIGRATION_0002_UP = (
  /* sql */
  `
-- Human-confirm queue for identity stitching (SPEC \xA76.3 WP-IDENTITY)
CREATE TABLE IF NOT EXISTS candidate_matches (
  id              TEXT    NOT NULL PRIMARY KEY,
  identity_id_a   TEXT    NOT NULL REFERENCES identities(id),
  identity_id_b   TEXT    NOT NULL REFERENCES identities(id),
  reason          TEXT    NOT NULL CHECK (reason IN ('local_part_name', 'fuzzy_name')),
  confidence      REAL    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  decided_at      TEXT,
  decided_by      TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  -- Ordered-pair uniqueness: normalise so id_a < id_b lexicographically
  UNIQUE (identity_id_a, identity_id_b, reason)
);

CREATE INDEX IF NOT EXISTS idx_candidate_matches_status ON candidate_matches(status);
CREATE INDEX IF NOT EXISTS idx_candidate_matches_pair ON candidate_matches(identity_id_a, identity_id_b);
`
);
var MIGRATION_0002_DOWN = (
  /* sql */
  `
DROP TABLE IF EXISTS candidate_matches;
`
);

// ../core/src/migrate/runner.ts
var MIGRATIONS = [
  {
    version: 1,
    description: "initial_schema",
    up: MIGRATION_0001_UP,
    down: MIGRATION_0001_DOWN
  },
  {
    version: 2,
    description: "candidate_matches",
    up: MIGRATION_0002_UP,
    down: MIGRATION_0002_DOWN
  }
];
function migrate(db, direction = "up") {
  if (direction === "down") {
    if (process.env.LAZYFLOW_ALLOW_DOWN_MIGRATIONS !== "1") {
      throw new Error(
        "Down migrations are disabled in production. Set LAZYFLOW_ALLOW_DOWN_MIGRATIONS=1 to allow."
      );
    }
  }
  ensureVersionTable(db);
  if (direction === "up") {
    migrateUp(db);
  } else {
    migrateDown(db);
  }
}
function ensureVersionTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER NOT NULL,
      applied_at  TEXT    NOT NULL,
      description TEXT    NOT NULL
    )
  `);
}
function appliedVersions(db) {
  const rows = db.prepare(`SELECT version FROM schema_version`).all();
  return new Set(rows.map((r) => r.version));
}
function migrateUp(db) {
  const applied = appliedVersions(db);
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).sort(
    (a, b2) => a.version - b2.version
  );
  for (const migration of pending) {
    db.exec(migration.up);
    db.prepare(
      `INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)`
    ).run(migration.version, (/* @__PURE__ */ new Date()).toISOString(), migration.description);
  }
}
function migrateDown(db) {
  const applied = appliedVersions(db);
  const toRevert = MIGRATIONS.filter((m) => applied.has(m.version)).sort(
    (a, b2) => b2.version - a.version
    // descending
  );
  for (const migration of toRevert) {
    db.exec(migration.down);
    db.prepare(`DELETE FROM schema_version WHERE version = ?`).run(migration.version);
  }
}

// ../core/src/stats/ratio.ts
function safeRatio(numerator, denominator) {
  if (denominator === 0) return null;
  return numerator / denominator;
}

// ../core/src/store/NodeSqliteStore.ts
import { DatabaseSync } from "node:sqlite";
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function b(v) {
  return v ? 1 : 0;
}
function rb(v) {
  return v === 1 || v === true;
}
function rstr(v) {
  if (v === null || v === void 0) return null;
  return String(v);
}
function rnum(v) {
  if (v === null || v === void 0) return null;
  return Number(v);
}
function mapCandidateMatch(r) {
  return {
    id: String(r.id),
    identityIdA: String(r.identity_id_a),
    identityIdB: String(r.identity_id_b),
    reason: r.reason,
    confidence: Number(r.confidence),
    status: r.status,
    decidedAt: rstr(r.decided_at),
    decidedBy: rstr(r.decided_by),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at)
  };
}
var NodeSqliteStore = class {
  db;
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL`);
    this.db.exec(`PRAGMA busy_timeout = 5000`);
    this.db.exec(`PRAGMA foreign_keys = ON`);
  }
  /** Close the underlying database connection. */
  close() {
    this.db.close();
  }
  // Prepare a statement lazily — cached per SQL string for efficiency.
  // Using a map avoids re-preparing on every call while keeping the impl simple.
  _stmts = /* @__PURE__ */ new Map();
  stmt(sql) {
    let s = this._stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this._stmts.set(sql, s);
    }
    return s;
  }
  // ---------------------------------------------------------------------------
  // Organisations
  // ---------------------------------------------------------------------------
  async upsertOrganisation(org) {
    this.stmt(`
      INSERT INTO organisations (id, github_login, jira_cloud_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        github_login  = CASE WHEN excluded.updated_at >= organisations.updated_at THEN excluded.github_login  ELSE organisations.github_login  END,
        jira_cloud_id = CASE WHEN excluded.updated_at >= organisations.updated_at THEN excluded.jira_cloud_id ELSE organisations.jira_cloud_id END,
        name          = CASE WHEN excluded.updated_at >= organisations.updated_at THEN excluded.name          ELSE organisations.name          END,
        updated_at    = CASE WHEN excluded.updated_at >= organisations.updated_at THEN excluded.updated_at    ELSE organisations.updated_at    END
    `).run(org.id, org.githubLogin, org.jiraCloudId, org.name, org.createdAt, org.updatedAt);
  }
  async getOrganisation(id) {
    const row = this.stmt(
      `SELECT id, github_login, jira_cloud_id, name, created_at, updated_at FROM organisations WHERE id = ?`
    ).get(id);
    if (!row) return null;
    return {
      id: String(row.id),
      githubLogin: rstr(row.github_login),
      jiraCloudId: rstr(row.jira_cloud_id),
      name: String(row.name),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }
  // ---------------------------------------------------------------------------
  // Persons
  // ---------------------------------------------------------------------------
  async upsertPerson(person) {
    this.stmt(`
      INSERT INTO persons (id, display_name, primary_account_ref, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name        = CASE WHEN excluded.updated_at >= persons.updated_at THEN excluded.display_name        ELSE persons.display_name        END,
        primary_account_ref = CASE WHEN excluded.updated_at >= persons.updated_at THEN excluded.primary_account_ref ELSE persons.primary_account_ref END,
        updated_at          = CASE WHEN excluded.updated_at >= persons.updated_at THEN excluded.updated_at          ELSE persons.updated_at          END
    `).run(person.id, person.displayName, person.primaryAccountRef, person.updatedAt);
  }
  async getPerson(id) {
    const row = this.stmt(
      `SELECT id, display_name, primary_account_ref, updated_at FROM persons WHERE id = ?`
    ).get(id);
    if (!row) return null;
    return {
      id: String(row.id),
      displayName: String(row.display_name),
      primaryAccountRef: String(row.primary_account_ref),
      updatedAt: String(row.updated_at)
    };
  }
  // ---------------------------------------------------------------------------
  // Identities
  // ---------------------------------------------------------------------------
  async upsertIdentity(identity) {
    this.stmt(`
      INSERT INTO identities (id, person_id, kind, external_id, is_bot, confidence, raw, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        person_id   = CASE WHEN excluded.updated_at >= identities.updated_at THEN excluded.person_id   ELSE identities.person_id   END,
        kind        = CASE WHEN excluded.updated_at >= identities.updated_at THEN excluded.kind        ELSE identities.kind        END,
        external_id = CASE WHEN excluded.updated_at >= identities.updated_at THEN excluded.external_id ELSE identities.external_id END,
        is_bot      = CASE WHEN excluded.updated_at >= identities.updated_at THEN excluded.is_bot      ELSE identities.is_bot      END,
        confidence  = CASE WHEN excluded.updated_at >= identities.updated_at THEN excluded.confidence  ELSE identities.confidence  END,
        raw         = CASE WHEN excluded.updated_at >= identities.updated_at THEN excluded.raw         ELSE identities.raw         END,
        updated_at  = CASE WHEN excluded.updated_at >= identities.updated_at THEN excluded.updated_at  ELSE identities.updated_at  END
    `).run(
      identity.id,
      identity.personId,
      identity.kind,
      identity.externalId,
      b(identity.isBot),
      identity.confidence,
      identity.raw,
      identity.updatedAt
    );
  }
  async getIdentitiesByPerson(personId) {
    const rows = this.stmt(
      `SELECT id, person_id, kind, external_id, is_bot, confidence, raw, updated_at
       FROM identities WHERE person_id = ?`
    ).all(personId);
    return rows.map((r) => ({
      id: String(r.id),
      personId: rstr(r.person_id),
      kind: r.kind,
      externalId: String(r.external_id),
      isBot: rb(r.is_bot),
      confidence: Number(r.confidence),
      raw: String(r.raw),
      updatedAt: String(r.updated_at)
    }));
  }
  // ---------------------------------------------------------------------------
  // Repositories
  // ---------------------------------------------------------------------------
  async upsertRepository(repo) {
    this.stmt(`
      INSERT INTO repositories (id, github_node_id, org_id, owner, name, default_branch,
        is_archived, is_fork, deleted_at, raw, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        github_node_id = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.github_node_id ELSE repositories.github_node_id END,
        org_id         = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.org_id         ELSE repositories.org_id         END,
        owner          = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.owner          ELSE repositories.owner          END,
        name           = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.name           ELSE repositories.name           END,
        default_branch = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.default_branch ELSE repositories.default_branch END,
        is_archived    = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.is_archived    ELSE repositories.is_archived    END,
        is_fork        = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.is_fork        ELSE repositories.is_fork        END,
        deleted_at     = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.deleted_at     ELSE repositories.deleted_at     END,
        raw            = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.raw            ELSE repositories.raw            END,
        updated_at     = CASE WHEN excluded.updated_at >= repositories.updated_at THEN excluded.updated_at     ELSE repositories.updated_at     END
    `).run(
      repo.id,
      repo.githubNodeId,
      repo.orgId,
      repo.owner,
      repo.name,
      repo.defaultBranch,
      b(repo.isArchived),
      b(repo.isFork),
      repo.deletedAt,
      repo.raw,
      repo.createdAt,
      repo.updatedAt
    );
  }
  async getRepository(id) {
    const row = this.stmt(
      `SELECT id, github_node_id, org_id, owner, name, default_branch,
              is_archived, is_fork, deleted_at, raw, created_at, updated_at
       FROM repositories WHERE id = ? AND deleted_at IS NULL`
    ).get(id);
    if (!row) return null;
    return this._rowToRepository(row);
  }
  async getRepositoriesByOrg(orgId) {
    const rows = this.stmt(
      `SELECT id, github_node_id, org_id, owner, name, default_branch,
              is_archived, is_fork, deleted_at, raw, created_at, updated_at
       FROM repositories WHERE org_id = ? AND deleted_at IS NULL`
    ).all(orgId);
    return rows.map((r) => this._rowToRepository(r));
  }
  _rowToRepository(r) {
    return {
      id: String(r.id),
      githubNodeId: String(r.github_node_id),
      orgId: String(r.org_id),
      owner: String(r.owner),
      name: String(r.name),
      defaultBranch: String(r.default_branch),
      isArchived: rb(r.is_archived),
      isFork: rb(r.is_fork),
      deletedAt: rstr(r.deleted_at),
      raw: String(r.raw),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at)
    };
  }
  // ---------------------------------------------------------------------------
  // Commits
  // ---------------------------------------------------------------------------
  async upsertCommit(commit) {
    this.stmt(`
      INSERT INTO commits (repo_id, sha, author_identity_id, authored_at, committed_at,
        additions, deletions, haloc, raw, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, sha) DO UPDATE SET
        author_identity_id = CASE WHEN excluded.updated_at >= commits.updated_at THEN excluded.author_identity_id ELSE commits.author_identity_id END,
        authored_at        = CASE WHEN excluded.updated_at >= commits.updated_at THEN excluded.authored_at        ELSE commits.authored_at        END,
        committed_at       = CASE WHEN excluded.updated_at >= commits.updated_at THEN excluded.committed_at       ELSE commits.committed_at       END,
        additions          = CASE WHEN excluded.updated_at >= commits.updated_at THEN excluded.additions          ELSE commits.additions          END,
        deletions          = CASE WHEN excluded.updated_at >= commits.updated_at THEN excluded.deletions          ELSE commits.deletions          END,
        haloc              = CASE WHEN excluded.updated_at >= commits.updated_at THEN excluded.haloc              ELSE commits.haloc              END,
        raw                = CASE WHEN excluded.updated_at >= commits.updated_at THEN excluded.raw                ELSE commits.raw                END,
        updated_at         = CASE WHEN excluded.updated_at >= commits.updated_at THEN excluded.updated_at         ELSE commits.updated_at         END
    `).run(
      commit.repoId,
      commit.sha,
      commit.authorIdentityId,
      commit.authoredAt,
      commit.committedAt,
      commit.additions,
      commit.deletions,
      commit.haloc,
      commit.raw,
      commit.createdAt,
      commit.updatedAt
    );
  }
  async getCommitsByRepo(repoId, since, until) {
    let sql = `SELECT repo_id, sha, author_identity_id, authored_at, committed_at, additions, deletions, haloc, raw, created_at, updated_at FROM commits WHERE repo_id = ?`;
    const params = [repoId];
    if (since) {
      sql += ` AND authored_at >= ?`;
      params.push(since);
    }
    if (until) {
      sql += ` AND authored_at <= ?`;
      params.push(until);
    }
    sql += ` ORDER BY authored_at ASC`;
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r) => ({
      repoId: String(r.repo_id),
      sha: String(r.sha),
      authorIdentityId: String(r.author_identity_id),
      authoredAt: String(r.authored_at),
      committedAt: String(r.committed_at),
      additions: Number(r.additions),
      deletions: Number(r.deletions),
      haloc: Number(r.haloc),
      raw: String(r.raw),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at)
    }));
  }
  // ---------------------------------------------------------------------------
  // Commit authors (co-authors / trailers)
  // ---------------------------------------------------------------------------
  async upsertCommitAuthor(author) {
    this.stmt(`
      INSERT INTO commit_authors (repo_id, sha, identity_id, role, source)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, sha, identity_id, role) DO NOTHING
    `).run(author.repoId, author.sha, author.identityId, author.role, author.source);
  }
  async getCommitAuthors(repoId, sha) {
    const rows = this.stmt(
      `SELECT repo_id, sha, identity_id, role, source
       FROM commit_authors WHERE repo_id = ? AND sha = ?`
    ).all(repoId, sha);
    return rows.map((r) => ({
      repoId: String(r.repo_id),
      sha: String(r.sha),
      identityId: String(r.identity_id),
      role: r.role,
      source: r.source
    }));
  }
  // ---------------------------------------------------------------------------
  // Pull requests
  // ---------------------------------------------------------------------------
  async upsertPullRequest(pr) {
    this.stmt(`
      INSERT INTO pull_requests (id, repo_id, number, author_identity_id, state,
        head_ref, base_ref, is_draft, merged_via_queue, created_at, ready_at,
        first_commit_at, first_review_at, approved_at, merged_at,
        merged_by_identity_id, deleted_at, raw, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state                 = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.state                 ELSE pull_requests.state                 END,
        head_ref              = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.head_ref              ELSE pull_requests.head_ref              END,
        base_ref              = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.base_ref              ELSE pull_requests.base_ref              END,
        is_draft              = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.is_draft              ELSE pull_requests.is_draft              END,
        merged_via_queue      = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.merged_via_queue      ELSE pull_requests.merged_via_queue      END,
        ready_at              = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.ready_at              ELSE pull_requests.ready_at              END,
        first_commit_at       = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.first_commit_at       ELSE pull_requests.first_commit_at       END,
        first_review_at       = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.first_review_at       ELSE pull_requests.first_review_at       END,
        approved_at           = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.approved_at           ELSE pull_requests.approved_at           END,
        merged_at             = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.merged_at             ELSE pull_requests.merged_at             END,
        merged_by_identity_id = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.merged_by_identity_id ELSE pull_requests.merged_by_identity_id END,
        deleted_at            = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.deleted_at            ELSE pull_requests.deleted_at            END,
        raw                   = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.raw                   ELSE pull_requests.raw                   END,
        updated_at            = CASE WHEN excluded.updated_at >= pull_requests.updated_at THEN excluded.updated_at            ELSE pull_requests.updated_at            END
    `).run(
      pr.id,
      pr.repoId,
      pr.number,
      pr.authorIdentityId,
      pr.state,
      pr.headRef,
      pr.baseRef,
      b(pr.isDraft),
      b(pr.mergedViaQueue),
      pr.createdAt,
      pr.readyAt,
      pr.firstCommitAt,
      pr.firstReviewAt,
      pr.approvedAt,
      pr.mergedAt,
      pr.mergedByIdentityId,
      pr.deletedAt,
      pr.raw,
      pr.updatedAt
    );
  }
  async getPullRequest(id) {
    const row = this.stmt(
      `SELECT id, repo_id, number, author_identity_id, state, head_ref, base_ref,
              is_draft, merged_via_queue, created_at, ready_at, first_commit_at,
              first_review_at, approved_at, merged_at, merged_by_identity_id,
              deleted_at, raw, updated_at
       FROM pull_requests WHERE id = ? AND deleted_at IS NULL`
    ).get(id);
    if (!row) return null;
    return this._rowToPullRequest(row);
  }
  async getPullRequestsByRepo(repoId, since, until) {
    let sql = `SELECT id, repo_id, number, author_identity_id, state, head_ref, base_ref, is_draft, merged_via_queue, created_at, ready_at, first_commit_at, first_review_at, approved_at, merged_at, merged_by_identity_id, deleted_at, raw, updated_at FROM pull_requests WHERE repo_id = ? AND deleted_at IS NULL`;
    const params = [repoId];
    if (since) {
      sql += ` AND created_at >= ?`;
      params.push(since);
    }
    if (until) {
      sql += ` AND created_at <= ?`;
      params.push(until);
    }
    sql += ` ORDER BY created_at ASC`;
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r) => this._rowToPullRequest(r));
  }
  _rowToPullRequest(r) {
    return {
      id: String(r.id),
      repoId: String(r.repo_id),
      number: Number(r.number),
      authorIdentityId: String(r.author_identity_id),
      state: r.state,
      headRef: String(r.head_ref),
      baseRef: String(r.base_ref),
      isDraft: rb(r.is_draft),
      mergedViaQueue: rb(r.merged_via_queue),
      createdAt: String(r.created_at),
      readyAt: rstr(r.ready_at),
      firstCommitAt: rstr(r.first_commit_at),
      firstReviewAt: rstr(r.first_review_at),
      approvedAt: rstr(r.approved_at),
      mergedAt: rstr(r.merged_at),
      mergedByIdentityId: rstr(r.merged_by_identity_id),
      deletedAt: rstr(r.deleted_at),
      raw: String(r.raw),
      updatedAt: String(r.updated_at)
    };
  }
  // ---------------------------------------------------------------------------
  // Reviews
  // ---------------------------------------------------------------------------
  async upsertReview(review) {
    this.stmt(`
      INSERT INTO reviews (node_id, pr_id, reviewer_identity_id, state, submitted_at, raw, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        state                = CASE WHEN excluded.updated_at >= reviews.updated_at THEN excluded.state                ELSE reviews.state                END,
        submitted_at         = CASE WHEN excluded.updated_at >= reviews.updated_at THEN excluded.submitted_at         ELSE reviews.submitted_at         END,
        reviewer_identity_id = CASE WHEN excluded.updated_at >= reviews.updated_at THEN excluded.reviewer_identity_id ELSE reviews.reviewer_identity_id END,
        raw                  = CASE WHEN excluded.updated_at >= reviews.updated_at THEN excluded.raw                  ELSE reviews.raw                  END,
        updated_at           = CASE WHEN excluded.updated_at >= reviews.updated_at THEN excluded.updated_at           ELSE reviews.updated_at           END
    `).run(
      review.nodeId,
      review.prId,
      review.reviewerIdentityId,
      review.state,
      review.submittedAt,
      review.raw,
      review.updatedAt
    );
  }
  async getReviewsByPullRequest(prId) {
    const rows = this.stmt(
      `SELECT node_id, pr_id, reviewer_identity_id, state, submitted_at, raw, updated_at
       FROM reviews WHERE pr_id = ? ORDER BY submitted_at ASC`
    ).all(prId);
    return rows.map((r) => ({
      nodeId: String(r.node_id),
      prId: String(r.pr_id),
      reviewerIdentityId: String(r.reviewer_identity_id),
      state: r.state,
      submittedAt: String(r.submitted_at),
      raw: String(r.raw),
      updatedAt: String(r.updated_at)
    }));
  }
  // ---------------------------------------------------------------------------
  // Review comments
  // ---------------------------------------------------------------------------
  async upsertReviewComment(comment) {
    this.stmt(`
      INSERT INTO review_comments (node_id, pr_id, author_identity_id, created_at, in_reply_to, path, raw, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        author_identity_id = CASE WHEN excluded.updated_at >= review_comments.updated_at THEN excluded.author_identity_id ELSE review_comments.author_identity_id END,
        in_reply_to        = CASE WHEN excluded.updated_at >= review_comments.updated_at THEN excluded.in_reply_to        ELSE review_comments.in_reply_to        END,
        path               = CASE WHEN excluded.updated_at >= review_comments.updated_at THEN excluded.path               ELSE review_comments.path               END,
        raw                = CASE WHEN excluded.updated_at >= review_comments.updated_at THEN excluded.raw                ELSE review_comments.raw                END,
        updated_at         = CASE WHEN excluded.updated_at >= review_comments.updated_at THEN excluded.updated_at         ELSE review_comments.updated_at         END
    `).run(
      comment.nodeId,
      comment.prId,
      comment.authorIdentityId,
      comment.createdAt,
      comment.inReplyTo,
      comment.path,
      comment.raw,
      comment.updatedAt
    );
  }
  async getReviewCommentsByPullRequest(prId) {
    const rows = this.stmt(
      `SELECT node_id, pr_id, author_identity_id, created_at, in_reply_to, path, raw, updated_at
       FROM review_comments WHERE pr_id = ? ORDER BY created_at ASC`
    ).all(prId);
    return rows.map((r) => ({
      nodeId: String(r.node_id),
      prId: String(r.pr_id),
      authorIdentityId: String(r.author_identity_id),
      createdAt: String(r.created_at),
      inReplyTo: rstr(r.in_reply_to),
      path: rstr(r.path),
      raw: String(r.raw),
      updatedAt: String(r.updated_at)
    }));
  }
  // ---------------------------------------------------------------------------
  // Check runs
  // ---------------------------------------------------------------------------
  async upsertCheckRun(checkRun) {
    this.stmt(`
      INSERT INTO check_runs (node_id, repo_id, head_sha, name, status, conclusion, started_at, completed_at, raw, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        status       = CASE WHEN excluded.updated_at >= check_runs.updated_at THEN excluded.status       ELSE check_runs.status       END,
        conclusion   = CASE WHEN excluded.updated_at >= check_runs.updated_at THEN excluded.conclusion   ELSE check_runs.conclusion   END,
        started_at   = CASE WHEN excluded.updated_at >= check_runs.updated_at THEN excluded.started_at   ELSE check_runs.started_at   END,
        completed_at = CASE WHEN excluded.updated_at >= check_runs.updated_at THEN excluded.completed_at ELSE check_runs.completed_at END,
        raw          = CASE WHEN excluded.updated_at >= check_runs.updated_at THEN excluded.raw          ELSE check_runs.raw          END,
        updated_at   = CASE WHEN excluded.updated_at >= check_runs.updated_at THEN excluded.updated_at   ELSE check_runs.updated_at   END
    `).run(
      checkRun.nodeId,
      checkRun.repoId,
      checkRun.headSha,
      checkRun.name,
      checkRun.status,
      checkRun.conclusion,
      checkRun.startedAt,
      checkRun.completedAt,
      checkRun.raw,
      checkRun.updatedAt
    );
  }
  async getCheckRunsByRepo(repoId, headSha) {
    let sql = `SELECT node_id, repo_id, head_sha, name, status, conclusion, started_at, completed_at, raw, updated_at FROM check_runs WHERE repo_id = ?`;
    const params = [repoId];
    if (headSha) {
      sql += ` AND head_sha = ?`;
      params.push(headSha);
    }
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r) => ({
      nodeId: String(r.node_id),
      repoId: String(r.repo_id),
      headSha: String(r.head_sha),
      name: String(r.name),
      status: String(r.status),
      conclusion: rstr(r.conclusion),
      startedAt: rstr(r.started_at),
      completedAt: rstr(r.completed_at),
      raw: String(r.raw),
      updatedAt: String(r.updated_at)
    }));
  }
  // ---------------------------------------------------------------------------
  // Deployments
  // ---------------------------------------------------------------------------
  async upsertDeployment(deployment) {
    this.stmt(`
      INSERT INTO deployments (id, repo_id, sha, environment, status, created_at, finished_at, source, raw, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status      = CASE WHEN excluded.updated_at >= deployments.updated_at THEN excluded.status      ELSE deployments.status      END,
        finished_at = CASE WHEN excluded.updated_at >= deployments.updated_at THEN excluded.finished_at ELSE deployments.finished_at END,
        raw         = CASE WHEN excluded.updated_at >= deployments.updated_at THEN excluded.raw         ELSE deployments.raw         END,
        updated_at  = CASE WHEN excluded.updated_at >= deployments.updated_at THEN excluded.updated_at  ELSE deployments.updated_at  END
    `).run(
      deployment.id,
      deployment.repoId,
      deployment.sha,
      deployment.environment,
      deployment.status,
      deployment.createdAt,
      deployment.finishedAt,
      deployment.source,
      deployment.raw,
      deployment.updatedAt
    );
  }
  async getDeploymentsByRepo(repoId, since, until) {
    let sql = `SELECT id, repo_id, sha, environment, status, created_at, finished_at, source, raw, updated_at FROM deployments WHERE repo_id = ?`;
    const params = [repoId];
    if (since) {
      sql += ` AND created_at >= ?`;
      params.push(since);
    }
    if (until) {
      sql += ` AND created_at <= ?`;
      params.push(until);
    }
    sql += ` ORDER BY created_at ASC`;
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r) => ({
      id: String(r.id),
      repoId: String(r.repo_id),
      sha: String(r.sha),
      environment: String(r.environment),
      status: String(r.status),
      createdAt: String(r.created_at),
      finishedAt: rstr(r.finished_at),
      source: r.source,
      raw: String(r.raw),
      updatedAt: String(r.updated_at)
    }));
  }
  // ---------------------------------------------------------------------------
  // Jira projects
  // ---------------------------------------------------------------------------
  async upsertJiraProject(project) {
    this.stmt(`
      INSERT INTO jira_projects (id, key, name, jira_cloud_id, raw, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        key           = CASE WHEN excluded.updated_at >= jira_projects.updated_at THEN excluded.key           ELSE jira_projects.key           END,
        name          = CASE WHEN excluded.updated_at >= jira_projects.updated_at THEN excluded.name          ELSE jira_projects.name          END,
        jira_cloud_id = CASE WHEN excluded.updated_at >= jira_projects.updated_at THEN excluded.jira_cloud_id ELSE jira_projects.jira_cloud_id END,
        raw           = CASE WHEN excluded.updated_at >= jira_projects.updated_at THEN excluded.raw           ELSE jira_projects.raw           END,
        updated_at    = CASE WHEN excluded.updated_at >= jira_projects.updated_at THEN excluded.updated_at    ELSE jira_projects.updated_at    END
    `).run(
      project.id,
      project.key,
      project.name,
      project.jiraCloudId,
      project.raw,
      project.createdAt,
      project.updatedAt
    );
  }
  async getJiraProject(id) {
    const row = this.stmt(
      `SELECT id, key, name, jira_cloud_id, raw, created_at, updated_at FROM jira_projects WHERE id = ?`
    ).get(id);
    if (!row) return null;
    return {
      id: String(row.id),
      key: String(row.key),
      name: String(row.name),
      jiraCloudId: String(row.jira_cloud_id),
      raw: String(row.raw),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }
  // ---------------------------------------------------------------------------
  // Issues
  // ---------------------------------------------------------------------------
  async upsertIssue(issue) {
    this.stmt(`
      INSERT INTO issues (id, project_id, key, type, status_id, status_category,
        story_points, story_points_field_id, story_points_raw, parent_id, epic_key,
        is_subtask, hierarchy_level, assignee_identity_id, created_at, resolved_at,
        deleted_at, raw, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        key                    = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.key                    ELSE issues.key                    END,
        type                   = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.type                   ELSE issues.type                   END,
        status_id              = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.status_id              ELSE issues.status_id              END,
        status_category        = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.status_category        ELSE issues.status_category        END,
        story_points           = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.story_points           ELSE issues.story_points           END,
        story_points_field_id  = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.story_points_field_id  ELSE issues.story_points_field_id  END,
        story_points_raw       = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.story_points_raw       ELSE issues.story_points_raw       END,
        parent_id              = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.parent_id              ELSE issues.parent_id              END,
        epic_key               = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.epic_key               ELSE issues.epic_key               END,
        is_subtask             = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.is_subtask             ELSE issues.is_subtask             END,
        hierarchy_level        = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.hierarchy_level        ELSE issues.hierarchy_level        END,
        assignee_identity_id   = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.assignee_identity_id   ELSE issues.assignee_identity_id   END,
        resolved_at            = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.resolved_at            ELSE issues.resolved_at            END,
        deleted_at             = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.deleted_at             ELSE issues.deleted_at             END,
        raw                    = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.raw                    ELSE issues.raw                    END,
        updated_at             = CASE WHEN excluded.updated_at >= issues.updated_at THEN excluded.updated_at             ELSE issues.updated_at             END
    `).run(
      issue.id,
      issue.projectId,
      issue.key,
      issue.type,
      issue.statusId,
      issue.statusCategory,
      issue.storyPoints,
      issue.storyPointsFieldId,
      issue.storyPointsRaw,
      issue.parentId,
      issue.epicKey,
      b(issue.isSubtask),
      issue.hierarchyLevel,
      issue.assigneeIdentityId,
      issue.createdAt,
      issue.resolvedAt,
      issue.deletedAt,
      issue.raw,
      issue.updatedAt
    );
  }
  async getIssue(id) {
    const row = this.stmt(
      `SELECT id, project_id, key, type, status_id, status_category, story_points,
              story_points_field_id, story_points_raw, parent_id, epic_key, is_subtask,
              hierarchy_level, assignee_identity_id, created_at, resolved_at, deleted_at,
              raw, updated_at
       FROM issues WHERE id = ? AND deleted_at IS NULL`
    ).get(id);
    if (!row) return null;
    return this._rowToIssue(row);
  }
  async getIssuesByProject(projectId) {
    const rows = this.stmt(
      `SELECT id, project_id, key, type, status_id, status_category, story_points,
              story_points_field_id, story_points_raw, parent_id, epic_key, is_subtask,
              hierarchy_level, assignee_identity_id, created_at, resolved_at, deleted_at,
              raw, updated_at
       FROM issues WHERE project_id = ? AND deleted_at IS NULL ORDER BY key ASC`
    ).all(projectId);
    return rows.map((r) => this._rowToIssue(r));
  }
  _rowToIssue(r) {
    return {
      id: String(r.id),
      projectId: String(r.project_id),
      key: String(r.key),
      type: String(r.type),
      statusId: String(r.status_id),
      statusCategory: r.status_category,
      storyPoints: rnum(r.story_points),
      storyPointsFieldId: rstr(r.story_points_field_id),
      storyPointsRaw: rstr(r.story_points_raw),
      parentId: rstr(r.parent_id),
      epicKey: rstr(r.epic_key),
      isSubtask: rb(r.is_subtask),
      hierarchyLevel: Number(r.hierarchy_level),
      assigneeIdentityId: rstr(r.assignee_identity_id),
      createdAt: String(r.created_at),
      resolvedAt: rstr(r.resolved_at),
      deletedAt: rstr(r.deleted_at),
      raw: String(r.raw),
      updatedAt: String(r.updated_at)
    };
  }
  // ---------------------------------------------------------------------------
  // Issue keys
  // ---------------------------------------------------------------------------
  async upsertIssueKey(issueKey) {
    this.stmt(`
      INSERT INTO issue_keys (issue_id, key, valid_from, valid_to)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(issue_id, key) DO UPDATE SET
        valid_from = excluded.valid_from,
        valid_to   = excluded.valid_to
    `).run(issueKey.issueId, issueKey.key, issueKey.validFrom, issueKey.validTo);
  }
  async getIssueKeys(issueId) {
    const rows = this.stmt(
      `SELECT issue_id, key, valid_from, valid_to FROM issue_keys WHERE issue_id = ? ORDER BY valid_from ASC`
    ).all(issueId);
    return rows.map((r) => ({
      issueId: String(r.issue_id),
      key: String(r.key),
      validFrom: String(r.valid_from),
      validTo: rstr(r.valid_to)
    }));
  }
  async resolveIssueKey(key, at) {
    const ts = at ?? (/* @__PURE__ */ new Date(864e13)).toISOString();
    const row = this.stmt(
      `SELECT issue_id FROM issue_keys
       WHERE key = ?
         AND valid_from <= ?
         AND (valid_to IS NULL OR valid_to > ?)
       LIMIT 1`
    ).get(key, ts, ts);
    return row ? String(row.issue_id) : null;
  }
  // ---------------------------------------------------------------------------
  // Issue transitions (append-only)
  // ---------------------------------------------------------------------------
  async appendIssueTransitions(transitions) {
    const insert = this.stmt(`
      INSERT OR IGNORE INTO issue_transitions
        (id, issue_id, from_status_id, to_status_id, project_id_at_transition, transitioned_at, actor_identity_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const t of transitions) {
      insert.run(
        t.id,
        t.issueId,
        t.fromStatusId,
        t.toStatusId,
        t.projectIdAtTransition,
        t.transitionedAt,
        t.actorIdentityId
      );
    }
  }
  async getIssueTransitions(issueId) {
    const rows = this.stmt(
      `SELECT id, issue_id, from_status_id, to_status_id, project_id_at_transition,
              transitioned_at, actor_identity_id
       FROM issue_transitions WHERE issue_id = ? ORDER BY transitioned_at ASC`
    ).all(issueId);
    return rows.map((r) => ({
      id: String(r.id),
      issueId: String(r.issue_id),
      fromStatusId: String(r.from_status_id),
      toStatusId: String(r.to_status_id),
      projectIdAtTransition: String(r.project_id_at_transition),
      transitionedAt: String(r.transitioned_at),
      actorIdentityId: rstr(r.actor_identity_id)
    }));
  }
  // ---------------------------------------------------------------------------
  // Sprints
  // ---------------------------------------------------------------------------
  async upsertSprint(sprint) {
    this.stmt(`
      INSERT INTO sprints (id, board_id, state, start_at, end_at, complete_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state       = CASE WHEN excluded.updated_at >= sprints.updated_at THEN excluded.state       ELSE sprints.state       END,
        start_at    = CASE WHEN excluded.updated_at >= sprints.updated_at THEN excluded.start_at    ELSE sprints.start_at    END,
        end_at      = CASE WHEN excluded.updated_at >= sprints.updated_at THEN excluded.end_at      ELSE sprints.end_at      END,
        complete_at = CASE WHEN excluded.updated_at >= sprints.updated_at THEN excluded.complete_at ELSE sprints.complete_at END,
        updated_at  = CASE WHEN excluded.updated_at >= sprints.updated_at THEN excluded.updated_at  ELSE sprints.updated_at  END
    `).run(
      sprint.id,
      sprint.boardId,
      sprint.state,
      sprint.startAt,
      sprint.endAt,
      sprint.completeAt,
      sprint.updatedAt
    );
  }
  async getSprint(id) {
    const row = this.stmt(
      `SELECT id, board_id, state, start_at, end_at, complete_at, updated_at FROM sprints WHERE id = ?`
    ).get(id);
    if (!row) return null;
    return {
      id: String(row.id),
      boardId: String(row.board_id),
      state: row.state,
      startAt: rstr(row.start_at),
      endAt: rstr(row.end_at),
      completeAt: rstr(row.complete_at),
      updatedAt: String(row.updated_at)
    };
  }
  async getSprintsByBoard(boardId) {
    const rows = this.stmt(
      `SELECT id, board_id, state, start_at, end_at, complete_at, updated_at
       FROM sprints WHERE board_id = ? ORDER BY start_at ASC`
    ).all(boardId);
    return rows.map((r) => ({
      id: String(r.id),
      boardId: String(r.board_id),
      state: r.state,
      startAt: rstr(r.start_at),
      endAt: rstr(r.end_at),
      completeAt: rstr(r.complete_at),
      updatedAt: String(r.updated_at)
    }));
  }
  // ---------------------------------------------------------------------------
  // Sprint membership events (append-only)
  // ---------------------------------------------------------------------------
  async appendSprintMembershipEvent(event) {
    this.stmt(`
      INSERT INTO sprint_membership_events
        (sprint_id, issue_id, change, points_at_event, transitioned_at, was_present_at_start)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.sprintId,
      event.issueId,
      event.change,
      event.pointsAtEvent,
      event.transitionedAt,
      b(event.wasPresentAtStart)
    );
  }
  async getSprintMembershipEvents(sprintId) {
    const rows = this.stmt(
      `SELECT sprint_id, issue_id, change, points_at_event, transitioned_at, was_present_at_start
       FROM sprint_membership_events WHERE sprint_id = ? ORDER BY transitioned_at ASC`
    ).all(sprintId);
    return rows.map((r) => ({
      sprintId: String(r.sprint_id),
      issueId: String(r.issue_id),
      change: r.change,
      pointsAtEvent: rnum(r.points_at_event),
      transitionedAt: String(r.transitioned_at),
      wasPresentAtStart: rb(r.was_present_at_start)
    }));
  }
  // ---------------------------------------------------------------------------
  // Board config
  // ---------------------------------------------------------------------------
  async upsertBoardConfig(config) {
    this.stmt(`
      INSERT INTO board_configs (board_id, type, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(board_id) DO UPDATE SET
        type       = CASE WHEN excluded.updated_at >= board_configs.updated_at THEN excluded.type       ELSE board_configs.type       END,
        updated_at = CASE WHEN excluded.updated_at >= board_configs.updated_at THEN excluded.updated_at ELSE board_configs.updated_at END
    `).run(config.boardId, config.type, config.updatedAt);
  }
  async getBoardConfig(boardId) {
    const row = this.stmt(
      `SELECT board_id, type, updated_at FROM board_configs WHERE board_id = ?`
    ).get(boardId);
    if (!row) return null;
    return {
      boardId: String(row.board_id),
      type: row.type,
      updatedAt: String(row.updated_at)
    };
  }
  async upsertBoardColumn(column) {
    this.stmt(`
      INSERT INTO board_columns (board_id, column_name, status_ids, is_started_col, is_done_col)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(board_id, column_name) DO UPDATE SET
        status_ids     = excluded.status_ids,
        is_started_col = excluded.is_started_col,
        is_done_col    = excluded.is_done_col
    `).run(
      column.boardId,
      column.columnName,
      column.statusIds,
      b(column.isStartedCol),
      b(column.isDoneCol)
    );
  }
  async getBoardColumns(boardId) {
    const rows = this.stmt(
      `SELECT board_id, column_name, status_ids, is_started_col, is_done_col
       FROM board_columns WHERE board_id = ?`
    ).all(boardId);
    return rows.map((r) => ({
      boardId: String(r.board_id),
      columnName: String(r.column_name),
      statusIds: String(r.status_ids),
      isStartedCol: rb(r.is_started_col),
      isDoneCol: rb(r.is_done_col)
    }));
  }
  // ---------------------------------------------------------------------------
  // Workflows
  // ---------------------------------------------------------------------------
  async upsertWorkflow(workflow) {
    this.stmt(`
      INSERT INTO workflows (workflow_id, name, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(workflow_id) DO UPDATE SET
        name       = CASE WHEN excluded.updated_at >= workflows.updated_at THEN excluded.name       ELSE workflows.name       END,
        updated_at = CASE WHEN excluded.updated_at >= workflows.updated_at THEN excluded.updated_at ELSE workflows.updated_at END
    `).run(workflow.workflowId, workflow.name, workflow.updatedAt);
  }
  async getWorkflow(workflowId) {
    const row = this.stmt(
      `SELECT workflow_id, name, updated_at FROM workflows WHERE workflow_id = ?`
    ).get(workflowId);
    if (!row) return null;
    return {
      workflowId: String(row.workflow_id),
      name: String(row.name),
      updatedAt: String(row.updated_at)
    };
  }
  async upsertWorkflowSchemeMapping(mapping) {
    this.stmt(`
      INSERT INTO workflow_scheme_mappings (project_id, issue_type, workflow_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, issue_type) DO UPDATE SET
        workflow_id = CASE WHEN excluded.updated_at >= workflow_scheme_mappings.updated_at THEN excluded.workflow_id ELSE workflow_scheme_mappings.workflow_id END,
        updated_at  = CASE WHEN excluded.updated_at >= workflow_scheme_mappings.updated_at THEN excluded.updated_at  ELSE workflow_scheme_mappings.updated_at  END
    `).run(mapping.projectId, mapping.issueType, mapping.workflowId, mapping.updatedAt);
  }
  async getWorkflowSchemeMappings(projectId) {
    const rows = this.stmt(
      `SELECT project_id, issue_type, workflow_id, updated_at
       FROM workflow_scheme_mappings WHERE project_id = ?`
    ).all(projectId);
    return rows.map((r) => ({
      projectId: String(r.project_id),
      issueType: String(r.issue_type),
      workflowId: String(r.workflow_id),
      updatedAt: String(r.updated_at)
    }));
  }
  // ---------------------------------------------------------------------------
  // Teams
  // ---------------------------------------------------------------------------
  async upsertTeam(team) {
    this.stmt(`
      INSERT INTO teams (id, name, org_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name       = CASE WHEN excluded.updated_at >= teams.updated_at THEN excluded.name       ELSE teams.name       END,
        org_id     = CASE WHEN excluded.updated_at >= teams.updated_at THEN excluded.org_id     ELSE teams.org_id     END,
        updated_at = CASE WHEN excluded.updated_at >= teams.updated_at THEN excluded.updated_at ELSE teams.updated_at END
    `).run(team.id, team.name, team.orgId, team.updatedAt);
  }
  async getTeam(id) {
    const row = this.stmt(`SELECT id, name, org_id, updated_at FROM teams WHERE id = ?`).get(id);
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      orgId: String(row.org_id),
      updatedAt: String(row.updated_at)
    };
  }
  async getTeamsByOrg(orgId) {
    const rows = this.stmt(`SELECT id, name, org_id, updated_at FROM teams WHERE org_id = ?`).all(
      orgId
    );
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      orgId: String(r.org_id),
      updatedAt: String(r.updated_at)
    }));
  }
  async upsertTeamMembership(membership) {
    this.stmt(`
      INSERT INTO team_membership (team_id, person_id, valid_from, valid_to)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(team_id, person_id, valid_from) DO UPDATE SET
        valid_to = excluded.valid_to
    `).run(membership.teamId, membership.personId, membership.validFrom, membership.validTo);
  }
  async getTeamMembers(teamId, at) {
    let sql = `SELECT team_id, person_id, valid_from, valid_to FROM team_membership WHERE team_id = ?`;
    const params = [teamId];
    if (at) {
      sql += ` AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`;
      params.push(at, at);
    }
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r) => ({
      teamId: String(r.team_id),
      personId: String(r.person_id),
      validFrom: String(r.valid_from),
      validTo: rstr(r.valid_to)
    }));
  }
  // ---------------------------------------------------------------------------
  // PR ↔ Issue links
  // ---------------------------------------------------------------------------
  async upsertPrIssueLink(link) {
    this.stmt(`
      INSERT INTO pr_issue_links (pr_id, issue_id, link_source, confidence)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(pr_id, issue_id, link_source) DO UPDATE SET
        confidence = excluded.confidence
    `).run(link.prId, link.issueId, link.linkSource, link.confidence);
  }
  async getPrIssueLinks(prId) {
    const rows = this.stmt(
      `SELECT pr_id, issue_id, link_source, confidence FROM pr_issue_links WHERE pr_id = ?`
    ).all(prId);
    return rows.map((r) => ({
      prId: String(r.pr_id),
      issueId: String(r.issue_id),
      linkSource: r.link_source,
      confidence: Number(r.confidence)
    }));
  }
  async getIssuePrLinks(issueId) {
    const rows = this.stmt(
      `SELECT pr_id, issue_id, link_source, confidence FROM pr_issue_links WHERE issue_id = ?`
    ).all(issueId);
    return rows.map((r) => ({
      prId: String(r.pr_id),
      issueId: String(r.issue_id),
      linkSource: r.link_source,
      confidence: Number(r.confidence)
    }));
  }
  // ---------------------------------------------------------------------------
  // Soft deletes
  // ---------------------------------------------------------------------------
  async softDelete(table, id) {
    this.db.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`).run(now(), id);
  }
  // ---------------------------------------------------------------------------
  // Metric snapshots
  // ---------------------------------------------------------------------------
  async putSnapshot(snapshot) {
    this.stmt(`
      INSERT INTO metric_snapshots
        (scope_type, scope_id, metric, day, value, window, trust_tier, data_quality,
         engine_version, ingest_watermark_version, coverage_fingerprint, computed_at, is_stale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_type, scope_id, metric, day, ingest_watermark_version) DO UPDATE SET
        value                = excluded.value,
        window               = excluded.window,
        trust_tier           = excluded.trust_tier,
        data_quality         = excluded.data_quality,
        engine_version       = excluded.engine_version,
        coverage_fingerprint = excluded.coverage_fingerprint,
        computed_at          = excluded.computed_at,
        is_stale             = excluded.is_stale
    `).run(
      snapshot.scopeType,
      snapshot.scopeId,
      snapshot.metric,
      snapshot.day,
      snapshot.value,
      snapshot.window,
      snapshot.trustTier,
      snapshot.dataQuality,
      snapshot.engineVersion,
      snapshot.ingestWatermarkVersion,
      snapshot.coverageFingerprint,
      snapshot.computedAt,
      b(snapshot.isStale)
    );
  }
  async getSnapshots(scopeType, scopeId, metric, from, to) {
    const rows = this.stmt(
      `SELECT scope_type, scope_id, metric, day, value, window, trust_tier, data_quality,
              engine_version, ingest_watermark_version, coverage_fingerprint, computed_at, is_stale
       FROM metric_snapshots
       WHERE scope_type = ? AND scope_id = ? AND metric = ? AND day >= ? AND day <= ?
       ORDER BY day ASC`
    ).all(scopeType, scopeId, metric, from, to);
    return rows.map((r) => ({
      scopeType: r.scope_type,
      scopeId: String(r.scope_id),
      metric: String(r.metric),
      day: String(r.day),
      value: rnum(r.value),
      window: String(r.window),
      trustTier: r.trust_tier,
      dataQuality: r.data_quality,
      engineVersion: String(r.engine_version),
      ingestWatermarkVersion: String(r.ingest_watermark_version),
      coverageFingerprint: String(r.coverage_fingerprint),
      computedAt: String(r.computed_at),
      isStale: rb(r.is_stale)
    }));
  }
  async markSnapshotsStale(scopeType, scopeId, metric, day) {
    this.stmt(
      `UPDATE metric_snapshots SET is_stale = 1
       WHERE scope_type = ? AND scope_id = ? AND metric = ? AND day = ?`
    ).run(scopeType, scopeId, metric, day);
  }
  // ---------------------------------------------------------------------------
  // AI verdicts
  // ---------------------------------------------------------------------------
  async insertAiVerdict(verdict) {
    this.stmt(`
      INSERT INTO ai_verdicts
        (id, subject_type, subject_id, metric, prompt_version, model_id, model_snapshot,
         request_shape, feature_vector_json, structured_verdict_json, evidence_json,
         confidence, created_at, corrected_by, correction_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      verdict.id,
      verdict.subjectType,
      verdict.subjectId,
      verdict.metric,
      verdict.promptVersion,
      verdict.modelId,
      verdict.modelSnapshot,
      verdict.requestShape,
      verdict.featureVectorJson,
      verdict.structuredVerdictJson,
      verdict.evidenceJson,
      verdict.confidence,
      verdict.createdAt,
      verdict.correctedBy,
      verdict.correctionJson
    );
  }
  async getAiVerdict(id) {
    const row = this.stmt(
      `SELECT id, subject_type, subject_id, metric, prompt_version, model_id, model_snapshot,
              request_shape, feature_vector_json, structured_verdict_json, evidence_json,
              confidence, created_at, corrected_by, correction_json
       FROM ai_verdicts WHERE id = ?`
    ).get(id);
    if (!row) return null;
    return this._rowToAiVerdict(row);
  }
  async correctAiVerdict(id, correctedBy, correctionJson) {
    this.stmt(`UPDATE ai_verdicts SET corrected_by = ?, correction_json = ? WHERE id = ?`).run(
      correctedBy,
      correctionJson,
      id
    );
  }
  _rowToAiVerdict(r) {
    return {
      id: String(r.id),
      subjectType: String(r.subject_type),
      subjectId: String(r.subject_id),
      metric: String(r.metric),
      promptVersion: String(r.prompt_version),
      modelId: String(r.model_id),
      modelSnapshot: String(r.model_snapshot),
      requestShape: String(r.request_shape),
      featureVectorJson: String(r.feature_vector_json),
      structuredVerdictJson: String(r.structured_verdict_json),
      evidenceJson: String(r.evidence_json),
      confidence: Number(r.confidence),
      createdAt: String(r.created_at),
      correctedBy: rstr(r.corrected_by),
      correctionJson: rstr(r.correction_json)
    };
  }
  // ---------------------------------------------------------------------------
  // Flow state models
  // ---------------------------------------------------------------------------
  async upsertFlowStateModel(model) {
    this.stmt(`
      INSERT INTO flow_state_models
        (workflow_id, status_id, flow_state, confidence, confirmed_by, confirmed_at, valid_from, valid_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workflow_id, status_id, valid_from) DO UPDATE SET
        flow_state   = excluded.flow_state,
        confidence   = excluded.confidence,
        confirmed_by = excluded.confirmed_by,
        confirmed_at = excluded.confirmed_at,
        valid_to     = excluded.valid_to
    `).run(
      model.workflowId,
      model.statusId,
      model.flowState,
      model.confidence,
      model.confirmedBy,
      model.confirmedAt,
      model.validFrom,
      model.validTo
    );
  }
  async getFlowStateModel(workflowId, statusId, at) {
    const ts = at ?? (/* @__PURE__ */ new Date()).toISOString();
    const row = this.stmt(
      `SELECT workflow_id, status_id, flow_state, confidence, confirmed_by, confirmed_at, valid_from, valid_to
       FROM flow_state_models
       WHERE workflow_id = ? AND status_id = ?
         AND valid_from <= ?
         AND (valid_to IS NULL OR valid_to > ?)
       ORDER BY valid_from DESC
       LIMIT 1`
    ).get(workflowId, statusId, ts, ts);
    if (!row) return null;
    return this._rowToFlowStateModel(row);
  }
  async getFlowStateModelsByWorkflow(workflowId) {
    const rows = this.stmt(
      `SELECT workflow_id, status_id, flow_state, confidence, confirmed_by, confirmed_at, valid_from, valid_to
       FROM flow_state_models WHERE workflow_id = ? ORDER BY status_id, valid_from ASC`
    ).all(workflowId);
    return rows.map((r) => this._rowToFlowStateModel(r));
  }
  _rowToFlowStateModel(r) {
    return {
      workflowId: String(r.workflow_id),
      statusId: String(r.status_id),
      flowState: r.flow_state,
      confidence: Number(r.confidence),
      confirmedBy: rstr(r.confirmed_by),
      confirmedAt: rstr(r.confirmed_at),
      validFrom: String(r.valid_from),
      validTo: rstr(r.valid_to)
    };
  }
  // ---------------------------------------------------------------------------
  // Status category history
  // ---------------------------------------------------------------------------
  async upsertStatusCategoryHistory(history) {
    this.stmt(`
      INSERT INTO status_category_history (status_id, category, valid_from, valid_to)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(status_id, valid_from) DO UPDATE SET
        category = excluded.category,
        valid_to = excluded.valid_to
    `).run(history.statusId, history.category, history.validFrom, history.validTo);
  }
  async getStatusCategory(statusId, at) {
    const ts = at ?? (/* @__PURE__ */ new Date()).toISOString();
    const row = this.stmt(
      `SELECT category FROM status_category_history
       WHERE status_id = ?
         AND valid_from <= ?
         AND (valid_to IS NULL OR valid_to > ?)
       ORDER BY valid_from DESC
       LIMIT 1`
    ).get(statusId, ts, ts);
    if (!row) return null;
    return row.category;
  }
  // ---------------------------------------------------------------------------
  // Sync state
  // ---------------------------------------------------------------------------
  async getSyncState(source, resource, scopeId) {
    const row = this.stmt(
      `SELECT source, resource, scope_id, cursor, watermark_at, last_run_at, status, error
       FROM sync_state WHERE source = ? AND resource = ? AND scope_id = ?`
    ).get(source, resource, scopeId);
    if (!row) return null;
    return {
      source: String(row.source),
      resource: String(row.resource),
      scopeId: String(row.scope_id),
      cursor: rstr(row.cursor),
      watermarkAt: rstr(row.watermark_at),
      lastRunAt: rstr(row.last_run_at),
      status: row.status,
      error: rstr(row.error)
    };
  }
  async putSyncState(cursor) {
    this.stmt(`
      INSERT INTO sync_state (source, resource, scope_id, cursor, watermark_at, last_run_at, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, resource, scope_id) DO UPDATE SET
        cursor       = excluded.cursor,
        watermark_at = excluded.watermark_at,
        last_run_at  = excluded.last_run_at,
        status       = excluded.status,
        error        = excluded.error
    `).run(
      cursor.source,
      cursor.resource,
      cursor.scopeId,
      cursor.cursor,
      cursor.watermarkAt,
      cursor.lastRunAt,
      cursor.status,
      cursor.error
    );
  }
  // ---------------------------------------------------------------------------
  // Extended organisation / Jira project list methods
  // ---------------------------------------------------------------------------
  async listOrganisations() {
    const rows = this.stmt(
      `SELECT id, github_login, jira_cloud_id, name, created_at, updated_at FROM organisations`
    ).all();
    return rows.map((r) => ({
      id: String(r.id),
      githubLogin: rstr(r.github_login),
      jiraCloudId: rstr(r.jira_cloud_id),
      name: String(r.name),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at)
    }));
  }
  async listJiraProjects() {
    const rows = this.stmt(
      `SELECT id, key, name, jira_cloud_id, raw, created_at, updated_at FROM jira_projects`
    ).all();
    return rows.map((r) => ({
      id: String(r.id),
      key: String(r.key),
      name: String(r.name),
      jiraCloudId: String(r.jira_cloud_id),
      raw: String(r.raw),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at)
    }));
  }
  // ---------------------------------------------------------------------------
  // Extended identity methods
  // ---------------------------------------------------------------------------
  async findIdentityByExternalId(kind, externalId) {
    const row = this.stmt(
      `SELECT id, person_id, kind, external_id, is_bot, confidence, raw, updated_at
       FROM identities WHERE kind = ? AND external_id = ?`
    ).get(kind, externalId);
    if (!row) return null;
    return {
      id: String(row.id),
      personId: rstr(row.person_id),
      kind: row.kind,
      externalId: String(row.external_id),
      isBot: rb(row.is_bot),
      confidence: Number(row.confidence),
      raw: String(row.raw),
      updatedAt: String(row.updated_at)
    };
  }
  async listAllIdentities() {
    const rows = this.stmt(
      `SELECT id, person_id, kind, external_id, is_bot, confidence, raw, updated_at
       FROM identities`
    ).all();
    return rows.map((r) => ({
      id: String(r.id),
      personId: rstr(r.person_id),
      kind: r.kind,
      externalId: String(r.external_id),
      isBot: rb(r.is_bot),
      confidence: Number(r.confidence),
      raw: String(r.raw),
      updatedAt: String(r.updated_at)
    }));
  }
  // ---------------------------------------------------------------------------
  // Backfill helpers — identity resolution pass
  // ---------------------------------------------------------------------------
  async setIssueAssigneeIdentity(issueId, identityId) {
    this.stmt(
      `UPDATE issues SET assignee_identity_id = ? WHERE id = ? AND assignee_identity_id IS NULL`
    ).run(identityId, issueId);
  }
  async setTransitionActorIdentity(transitionId, identityId) {
    this.stmt(
      `UPDATE issue_transitions SET actor_identity_id = ? WHERE id = ? AND actor_identity_id IS NULL`
    ).run(identityId, transitionId);
  }
  // ---------------------------------------------------------------------------
  // Candidate match queue
  // ---------------------------------------------------------------------------
  async appendCandidateMatch(match) {
    const [idA, idB] = match.identityIdA < match.identityIdB ? [match.identityIdA, match.identityIdB] : [match.identityIdB, match.identityIdA];
    this.stmt(`
      INSERT INTO candidate_matches
        (id, identity_id_a, identity_id_b, reason, confidence, status, decided_at, decided_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity_id_a, identity_id_b, reason) DO NOTHING
    `).run(
      match.id,
      idA,
      idB,
      match.reason,
      match.confidence,
      match.status,
      match.decidedAt,
      match.decidedBy,
      match.createdAt,
      match.updatedAt
    );
  }
  async getCandidateMatch(id) {
    const row = this.stmt(
      `SELECT id, identity_id_a, identity_id_b, reason, confidence, status,
              decided_at, decided_by, created_at, updated_at
       FROM candidate_matches WHERE id = ?`
    ).get(id);
    if (!row) return null;
    return mapCandidateMatch(row);
  }
  async getCandidateMatches(status) {
    const rows = status !== void 0 ? this.stmt(
      `SELECT id, identity_id_a, identity_id_b, reason, confidence, status,
                    decided_at, decided_by, created_at, updated_at
             FROM candidate_matches WHERE status = ?`
    ).all(status) : this.stmt(
      `SELECT id, identity_id_a, identity_id_b, reason, confidence, status,
                    decided_at, decided_by, created_at, updated_at
             FROM candidate_matches`
    ).all();
    return rows.map(mapCandidateMatch);
  }
  async resolveCandidateMatch(id, status, decidedBy, decidedAt) {
    const match = await this.getCandidateMatch(id);
    if (!match) throw new Error(`CandidateMatch not found: ${id}`);
    if (match.status !== "pending") {
      throw new Error(`CandidateMatch ${id} is already resolved (${match.status})`);
    }
    this.stmt(
      `UPDATE candidate_matches
       SET status = ?, decided_by = ?, decided_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(status, decidedBy, decidedAt, decidedAt, id);
    if (status === "confirmed") {
      const identityA = await this.findIdentityById(match.identityIdA);
      const identityB = await this.findIdentityById(match.identityIdB);
      if (!identityA || !identityB) return;
      const targetPersonId = identityA.personId ?? identityB.personId;
      if (!targetPersonId) return;
      if (identityA.personId !== targetPersonId) {
        this.stmt(`UPDATE identities SET person_id = ?, updated_at = ? WHERE id = ?`).run(
          targetPersonId,
          decidedAt,
          identityA.id
        );
      }
      if (identityB.personId !== targetPersonId) {
        this.stmt(`UPDATE identities SET person_id = ?, updated_at = ? WHERE id = ?`).run(
          targetPersonId,
          decidedAt,
          identityB.id
        );
      }
    }
  }
  /** Internal helper: get an identity by its primary id (not externalId). */
  async findIdentityById(id) {
    const row = this.stmt(
      `SELECT id, person_id, kind, external_id, is_bot, confidence, raw, updated_at
       FROM identities WHERE id = ?`
    ).get(id);
    if (!row) return null;
    return {
      id: String(row.id),
      personId: rstr(row.person_id),
      kind: row.kind,
      externalId: String(row.external_id),
      isBot: rb(row.is_bot),
      confidence: Number(row.confidence),
      raw: String(row.raw),
      updatedAt: String(row.updated_at)
    };
  }
};

// ../metrics/src/code/codeChangeImpact.ts
var DEFAULT_WEIGHTS = {
  editDiversity: 0.25,
  halocNorm: 0.25,
  fileCountNorm: 0.2,
  changeEntropy: 0.15,
  oldCodePct: 0.15
};
var FORMULA_DOC = "Code-Change Impact (SPEC \xA78.4, \xA79.2.7): Deterministic blend: edit_diversity=distinct files changed / 20 (capped 1); haloc_norm=haloc/(haloc+100); file_count_norm=min(1,files/20); change_entropy=Shannon entropy of file-path dirs; old_code_pct=legacyRefactorLines/totalLines. impact = \u03A3 weight_i * factor_i. All weights configurable. LLM rationale hook (Wave 5): llmRationale field.";
function computeChangeEntropy(filePaths) {
  if (filePaths.length === 0) return 0;
  const dirCounts = /* @__PURE__ */ new Map();
  for (const p of filePaths) {
    const lastSlash = p.lastIndexOf("/");
    const dir = lastSlash >= 0 ? p.slice(0, lastSlash) : ".";
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
  }
  const total = filePaths.length;
  let entropy = 0;
  for (const count of dirCounts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(dirCounts.size);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}
var codeChangeImpact = {
  id: "code.change_impact",
  trustTier: "deterministic",
  scope: "team",
  formulaDoc: FORMULA_DOC,
  params: { weights: DEFAULT_WEIGHTS },
  compute(inputs, asOf) {
    const weights = { ...DEFAULT_WEIGHTS };
    if (inputs.weightOverrides) {
      for (const [k, v] of Object.entries(inputs.weightOverrides)) {
        if (v !== void 0) weights[k] = v;
      }
    }
    const fileCount = inputs.filePaths.length;
    const factors = {
      // editDiversity: normalised file count (capped at 20 → 1.0)
      editDiversity: Math.min(1, safeRatio(fileCount, 20) ?? 0),
      // halocNorm: asymptotic normalisation, HALOC=0→0, HALOC=∞→1
      halocNorm: safeRatio(inputs.haloc, inputs.haloc + 100) ?? 0,
      // fileCountNorm: same as editDiversity (explicit separate factor)
      fileCountNorm: Math.min(1, safeRatio(fileCount, 20) ?? 0),
      // changeEntropy: Shannon entropy of directory distribution
      changeEntropy: computeChangeEntropy(inputs.filePaths),
      // oldCodePct: fraction of lines touching old code
      oldCodePct: safeRatio(inputs.legacyRefactorLines, inputs.totalLines)
    };
    const impactScore = Math.min(
      1,
      (weights.editDiversity ?? 0) * factors.editDiversity + (weights.halocNorm ?? 0) * factors.halocNorm + (weights.fileCountNorm ?? 0) * factors.fileCountNorm + (weights.changeEntropy ?? 0) * factors.changeEntropy + (weights.oldCodePct ?? 0) * (factors.oldCodePct ?? 0)
    );
    return {
      id: "code.change_impact",
      trustTier: "deterministic",
      scope: "team",
      value: impactScore,
      unit: "score",
      dataQuality: "ok",
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      impactScore,
      factors,
      weights,
      llmRationale: inputs.llmRationale ?? null
    };
  }
};

// ../code-analysis/src/complexity.ts
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
var _require = createRequire(import.meta.url);
var Parser = _require("web-tree-sitter");
var grammarDirOverride = null;
function setGrammarDir(dir) {
  grammarDirOverride = dir;
}

// ../metrics/src/snapshots/index.ts
var DEFAULT_GRACE_PERIOD_MS = 48 * 60 * 60 * 1e3;

// ../ai/src/impact/runImpact.ts
async function runImpact(opts, client, store, cache) {
  const asOf = (/* @__PURE__ */ new Date()).toISOString();
  const metricResult = codeChangeImpact.compute(
    {
      haloc: opts.haloc,
      filePaths: opts.filePaths,
      legacyRefactorLines: opts.legacyRefactorLines,
      totalLines: opts.totalLines,
      weightOverrides: opts.weightOverrides
    },
    asOf
  );
  const { impactScore, factors, weights } = metricResult;
  const userMessage = buildImpactUserMessage({
    filePaths: opts.filePaths,
    haloc: opts.haloc,
    impactScore,
    factors,
    weights
  });
  const contentHash = createHash5("sha256").update(JSON.stringify({ filePaths: opts.filePaths, haloc: opts.haloc })).digest("hex");
  const { value } = await runVerdict(
    {
      subjectType: "pull_request",
      subjectId: opts.subjectId,
      metric: "impact",
      promptVersion: IMPACT_PROMPT_VERSION,
      modelId: opts.modelId,
      maxTokens: 256,
      contentHash,
      featureVector: {
        impactScore,
        haloc: opts.haloc,
        fileCount: opts.filePaths.length
      },
      userMessage: `${IMPACT_SYSTEM_PROMPT}

${userMessage}`,
      // biome-ignore lint/suspicious/noExplicitAny: outputConfigFormat is opaque any at the harness boundary
      outputConfigFormat: impactOutputSchema
    },
    client,
    store,
    cache
  );
  return {
    impactScore,
    factors,
    weights,
    rationale: value?.rationale ?? null
  };
}

// ../ai/src/prquality/checks.ts
var ISSUE_REF_PATTERN = /([A-Z][A-Z0-9]+-\d+|#\d+)/;
var TEST_FILE_PATTERN = /\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/i;
var ATOMICITY_MAX_FILES = 10;
var ATOMICITY_MAX_HALOC = 400;
function runDeterministicChecks(opts) {
  const { prTitle, prBody, filePaths, haloc } = opts;
  return {
    has_description: prBody.trim().length > 10,
    linked_issue: ISSUE_REF_PATTERN.test(prTitle) || ISSUE_REF_PATTERN.test(prBody),
    has_tests: filePaths.some((p) => TEST_FILE_PATTERN.test(p)),
    is_atomic: filePaths.length <= ATOMICITY_MAX_FILES && haloc <= ATOMICITY_MAX_HALOC
  };
}
function boolToScore(b2) {
  return b2 ? 2 : 0;
}

// ../ai/src/prquality/types.ts
var DimensionScore = external_exports.enum(["0", "1", "2"]);
var LlmDimension = external_exports.object({
  /** Numeric score 0–2 as enum. */
  score: DimensionScore,
  /**
   * Verbatim quote from the PR body / diff that supports this score.
   * For score=0, this should be a short note explaining what is missing.
   * Must NOT be a paraphrase — substance evidence only.
   */
  evidence: external_exports.string()
});
var PrQualityLlmOutput = external_exports.object({
  /** Does the PR body explain WHY the change is made (not just what)? */
  explains_why: LlmDimension,
  /** Does the body content match the actual diff (no mismatch / stale copy-paste)? */
  matches_diff: LlmDimension,
  /**
   * Risk flags: does the change touch security-sensitive areas, migrations,
   * config changes, API contracts, or other high-blast-radius paths?
   * Score: 0=no risks noted, 1=some risks noted, 2=risks clearly documented with mitigations.
   */
  risk_flags: LlmDimension
});

// ../ai/src/prquality/prompt.ts
var PRQUALITY_PROMPT_VERSION = "prquality-v1";
var PRQUALITY_SYSTEM_PROMPT = `You are a code-review assistant scoring the quality of a pull request description.

You score THREE dimensions, each on a 0\u20132 scale:
  0 = absent or missing
  1 = partial / present but incomplete
  2 = clear and substantive

Dimension definitions:
- explains_why: Does the PR body explain WHY the change is needed (motivation, context, business reason)?
  This is about substance, not writing style. A terse "fix null deref in auth middleware; caused 5xx on login"
  scores 2. A verbose but content-free paragraph scores 0. Non-English text is equally valid.
- matches_diff: Does the PR body accurately describe what the diff does?
  Mismatch (stale copy-paste, wrong scope) = 0. Accurate = 2.
- risk_flags: Does the description explicitly note high-blast-radius areas?
  (security changes, DB migrations, API contract changes, config changes, etc.)
  0 = no risks noted at all, 1 = risks mentioned but no mitigations, 2 = risks + mitigations documented.

Rules:
- Quote VERBATIM text from the PR body as evidence. If score=0, note what is missing.
- Base your score on SUBSTANCE (what the text communicates), not length or prose quality.
- Non-English, terse, or bullet-point descriptions are evaluated fairly.
- Return JSON matching: { explains_why, matches_diff, risk_flags } each with { score, evidence }.
`;
function buildPrQualityUserMessage(opts) {
  const paths = opts.changedPaths.slice(0, 30).join("\n  ");
  return `## Pull Request

**Title:** ${opts.prTitle}

**Body:**
${opts.prBody || "(empty)"}

## Changed paths (first 30)
  ${paths || "(none)"}

## Diff summary (first 2000 chars)
${opts.diffSummary.slice(0, 2e3) || "(none)"}

---
Score the three dimensions: explains_why, matches_diff, risk_flags.
For each, provide a verbatim evidence quote and a score of 0, 1, or 2.
`;
}
var prQualityOutputSchema = PrQualityLlmOutput;
registerPrompt({
  insight: "prquality",
  version: PRQUALITY_PROMPT_VERSION,
  systemPrompt: PRQUALITY_SYSTEM_PROMPT,
  userPromptTemplate: (opts) => buildPrQualityUserMessage(
    opts
  )
});

// ../ai/src/prquality/runPrQuality.ts
import { createHash as createHash6 } from "node:crypto";
async function runPrQuality(opts, client, store, cache) {
  const deterministic = runDeterministicChecks({
    prTitle: opts.prTitle,
    prBody: opts.prBody,
    filePaths: opts.filePaths,
    haloc: opts.haloc
  });
  const userMessage = buildPrQualityUserMessage({
    prTitle: opts.prTitle,
    prBody: opts.prBody,
    diffSummary: opts.diffSummary,
    changedPaths: opts.filePaths
  });
  const contentHash = createHash6("sha256").update(
    JSON.stringify({
      prTitle: opts.prTitle,
      prBody: opts.prBody,
      diffSummary: opts.diffSummary.slice(0, 2e3)
    })
  ).digest("hex");
  const { value } = await runVerdict(
    {
      subjectType: "pull_request",
      subjectId: opts.prId,
      metric: "pr_quality",
      promptVersion: PRQUALITY_PROMPT_VERSION,
      modelId: opts.modelId,
      maxTokens: 1024,
      contentHash,
      featureVector: {
        hasDescription: deterministic.has_description,
        linkedIssue: deterministic.linked_issue,
        hasTests: deterministic.has_tests,
        isAtomic: deterministic.is_atomic,
        fileCount: opts.filePaths.length,
        haloc: opts.haloc
      },
      userMessage: `${PRQUALITY_SYSTEM_PROMPT}

${userMessage}`,
      // biome-ignore lint/suspicious/noExplicitAny: outputConfigFormat is opaque any at the harness boundary
      outputConfigFormat: prQualityOutputSchema
    },
    client,
    store,
    cache
  );
  const detScore = boolToScore(deterministic.has_description) + boolToScore(deterministic.linked_issue) + boolToScore(deterministic.has_tests) + boolToScore(deterministic.is_atomic);
  const llmScore = value ? Number(value.explains_why.score) + Number(value.matches_diff.score) + Number(value.risk_flags.score) : 0;
  return {
    deterministic,
    llm: value ?? void 0,
    overallScore: detScore + llmScore
  };
}

// ../ai/src/verdictCache.ts
function toCacheKey(k) {
  return `${k.subjectType}:${k.subjectId}:${k.contentHash}:${k.promptVersion}:${k.modelId}`;
}
var VerdictCache = class {
  mem = /* @__PURE__ */ new Map();
  get(key) {
    return this.mem.get(toCacheKey(key)) ?? null;
  }
  set(key, verdict) {
    this.mem.set(toCacheKey(key), verdict);
  }
  invalidate(key) {
    this.mem.delete(toCacheKey(key));
  }
  clear() {
    this.mem.clear();
  }
};

export {
  parseAcceptanceCriteria,
  scoreHunkRelevance,
  rankDiffHunks,
  buildAlignmentFeaturePack,
  RELEVANCE_THRESHOLD,
  applyEvidenceGuard,
  computeCoverageRatio,
  coverageRatioToOrdinal,
  applyMinRule,
  registerPrompt,
  getPrompt,
  listPrompts,
  ZodOptional,
  ZodFirstPartyTypeKind,
  objectType,
  external_exports,
  CoverageStatusEnum,
  AlignmentLlmOutput,
  ALIGNMENT_PROMPT_VERSION,
  ALIGNMENT_SYSTEM_PROMPT,
  buildAlignmentUserMessage,
  alignmentOutputSchema,
  DEFAULT_MODEL,
  ENSEMBLE_MODEL,
  requestShape,
  runVerdict,
  correctVerdict,
  runAlignment,
  MIN_SAMPLE_SIZE,
  computeEwmaZScore,
  detectAnomaly,
  AnomalyCause,
  RankedCause,
  AnomalyLlmOutput,
  ANOMALY_PROMPT_VERSION,
  ANOMALY_SYSTEM_PROMPT,
  buildAnomalyUserMessage,
  anomalyOutputSchema,
  runAnomaly,
  extractCorrections,
  correctionsToGoldItems,
  mergeGoldSets,
  groupByMetric,
  extractHumanPairs,
  canonicalLabels,
  extractPredictedLabel,
  extractPredictedRank,
  loadCorrectedVerdicts,
  cohenKappa,
  macroF1,
  spearmanRho,
  computeEce,
  confidenceIsCalibrated,
  buildCalibrationReport,
  classifyByConventionalCommit,
  classifyByPathPatterns,
  applyDeterministicPrior,
  CLASSIFY_PROMPT_VERSION,
  CLASSIFY_SYSTEM_PROMPT,
  buildClassifyUserMessage,
  WorkType,
  ClassifyLlmOutput,
  PriorSource,
  registerCalibrationHook,
  runClassify,
  AnthropicLlmClient,
  FakeLlmClient,
  EFFORT_PROMPT_VERSION,
  EFFORT_SYSTEM_PROMPT,
  buildEffortUserMessage,
  EffortBand,
  INSUFFICIENT_HISTORY,
  EFFORT_MIN_HISTORY_N,
  EXEMPT_ISSUE_TYPES,
  EffortLlmOutput,
  computeLogRatio,
  computeCycleTimeZScore,
  zScoreToEffortBand,
  logRatioToEffortBand,
  detectDisagreement,
  adjustConfidenceForDisagreement,
  runEffort,
  ImpactRationaleOutput,
  IMPACT_PROMPT_VERSION,
  IMPACT_SYSTEM_PROMPT,
  buildImpactUserMessage,
  impactOutputSchema,
  ENGINE_VERSION,
  resolveIdentities,
  stitchPersons,
  linkIssues,
  migrate,
  NodeSqliteStore,
  setGrammarDir,
  runImpact,
  ATOMICITY_MAX_FILES,
  ATOMICITY_MAX_HALOC,
  runDeterministicChecks,
  boolToScore,
  DimensionScore,
  LlmDimension,
  PrQualityLlmOutput,
  PRQUALITY_PROMPT_VERSION,
  PRQUALITY_SYSTEM_PROMPT,
  buildPrQualityUserMessage,
  prQualityOutputSchema,
  runPrQuality,
  VerdictCache
};

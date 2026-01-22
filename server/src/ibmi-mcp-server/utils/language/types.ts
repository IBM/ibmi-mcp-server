/* eslint-disable */
// @ts-nocheck
// Vendored from vscode-db2i - TypeScript strict mode and ESLint disabled
import Statement from "./statement.js";

export enum StatementType {
  Unknown = "Unknown",
  Create = "Create",
  Close = "Close",
  Insert = "Insert",
  Select = "Select",
  With = "With",
  Update = "Update",
  Delete = "Delete",
  Declare = "Declare",
  Begin = "Begin",
  Drop = "Drop",
  End = "End",
  Else = "Else",
  Elseif = "Elseif",
  Call = "Call",
  Alter = "Alter",
  Fetch = "Fetch",
  For = "For",
  Get = "Get",
  Goto = "Goto",
  If = "If",
  Include = "Include",
  Iterate = "Iterate",
  Leave = "Leave",
  Loop = "Loop",
  Merge = "Merge",
  Open = "Open",
  Pipe = "Pipe",
  Repeat = "Repeat",
  Resignal = "Resignal",
  Return = "Return",
  Signal = "Signal",
  Set = "Set",
  While = "While",
}

export const StatementTypeWord = {
  CREATE: StatementType.Create,
  SELECT: StatementType.Select,
  WITH: StatementType.With,
  INSERT: StatementType.Insert,
  UPDATE: StatementType.Update,
  DELETE: StatementType.Delete,
  DECLARE: StatementType.Declare,
  DROP: StatementType.Drop,
  END: StatementType.End,
  ELSE: StatementType.Else,
  ELSEIF: StatementType.Elseif,
  CALL: StatementType.Call,
  BEGIN: StatementType.Begin,
  ALTER: StatementType.Alter,
  FOR: StatementType.For,
  FETCH: StatementType.Fetch,
  GET: StatementType.Get,
  GOTO: StatementType.Goto,
  IF: StatementType.If,
  INCLUDE: StatementType.Include,
  ITERATE: StatementType.Iterate,
  LEAVE: StatementType.Leave,
  LOOP: StatementType.Loop,
  MERGE: StatementType.Merge,
  PIPE: StatementType.Pipe,
  REPEAT: StatementType.Repeat,
  RESIGNAL: StatementType.Resignal,
  RETURN: StatementType.Return,
  SIGNAL: StatementType.Signal,
  SET: StatementType.Set,
  WHILE: StatementType.While,
};

export enum ClauseType {
  Unknown = "Unknown",
  From = "From",
  Into = "Into",
  Where = "Where",
  Having = "Having",
  Group = "Group",
  Limit = "Limit",
  Offset = "Offset",
  Order = "Order",
}

export const ClauseTypeWord = {
  FROM: ClauseType.From,
  INTO: ClauseType.Into,
  WHERE: ClauseType.Where,
  HAVING: ClauseType.Having,
  GROUP: ClauseType.Group,
  LIMIT: ClauseType.Limit,
  OFFSET: ClauseType.Offset,
  ORDER: ClauseType.Order,
};

export interface CTEReference {
  name: string;
  columns: string[];
  statement: Statement;
}

export interface IRange {
  start: number;
  end: number;
}

export interface Token {
  value?: string;
  block?: Token[];
  type: string;
  range: IRange;
}

export interface QualifiedObject {
  schema?: string;
  name?: string;
  system?: string;
}

export interface ObjectRef {
  tokens: Token[];
  object: QualifiedObject;
  alias?: string;

  isUDTF?: boolean;
  fromLateral?: boolean;

  /** only used within create statements */
  createType?: string;
}

export interface StatementGroup {
  range: IRange;
  statements: Statement[];
}

export interface Definition extends ObjectRef {
  range: IRange;
  children: Definition[];
}

export interface ParsedEmbeddedStatement {
  changed: boolean;
  content: string;
  parameterCount: number;
}

export interface CallableReference {
  tokens: Token[];
  parentRef: ObjectRef;
}

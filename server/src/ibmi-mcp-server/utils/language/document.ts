/* eslint-disable */
// @ts-nocheck
// Vendored from vscode-db2i - TypeScript strict mode and ESLint disabled
import Statement from "./statement.js";
import SQLTokeniser from "./tokens.js";
import { CallableReference, Definition, ParsedEmbeddedStatement, StatementGroup, StatementType, StatementTypeWord, Token } from "./types.js";

export default class Document {
  content: string;
  statements: Statement[];
  debug: boolean = false;

  constructor(content: string, keepComments = false) {
    this.content = content;
    this.statements = [];

    const tokeniser = new SQLTokeniser();
    tokeniser.storeComments = keepComments;

    this.parseStatements(tokeniser.tokenise(content));
  }

  log(content: string) {
    if (this.debug) {
      console.log(content);
    }
  }

  private addStatement(tokens: Token[]) {
    if (tokens.length > 0) {
      tokens = Statement.trimTokens(tokens);

      if (tokens.length > 0) {
        this.statements.push(new Statement(
          tokens,
          {
            start: tokens[0].range.start,
            end: tokens[tokens.length - 1].range.end
          }
        ));
      }
    }
  }

  private parseStatements(tokens: Token[]) {
    let currentStatementType: StatementType = StatementType.Unknown;
    let statementStart = 0;
    let bracketDepth = 0;

    for (let i = 0; i < tokens.length; i++) {
      const upperValue = tokens[i].value?.toUpperCase();
      switch (tokens[i].type) {
        case `openbracket`:
          bracketDepth++;
          break;
        case `closebracket`:
          bracketDepth--;
          break;
        case `semicolon`:
          const statementTokens = tokens.slice(statementStart, i);

          this.addStatement(statementTokens);

          statementStart = i + 1;
          break;

        case `statementType`:
          currentStatementType = StatementTypeWord[upperValue];
          break;

        case `keyword`:
          if (bracketDepth === 0) {
            switch (upperValue) {
              case `LOOP`:
              case `THEN`:
              case `BEGIN`:
              case `ELSE`:
              case `DO`:
                // This handles the case that 'END LOOP' is supported.
                if (upperValue === `LOOP` && currentStatementType === StatementType.End) {
                  break;
                }

                // Support for THEN in conditionals
                if (upperValue === `THEN` && !Statement.typeIsConditional(currentStatementType)) {
                  break;
                }

                if (upperValue === `ELSE` && !Statement.typeIsConditional(currentStatementType)) {
                  break;
                }

                if (upperValue === `BEGIN` && currentStatementType === StatementType.Alter) {
                  break;
                }

                // We include BEGIN in the current statement
                // then the next statement beings
                const statementTokens = tokens.slice(statementStart, i+1);
                this.addStatement(statementTokens);
                statementStart = i + 1;
                break;
              case `END`:
                // We ignore the END statement keyword when it's solo.
                if (statementStart === i && (tokens[i] === undefined || tokens[i].type === `semicolon`)) {
                  statementStart = i + 1;
                }
                break;
            }
          }
          break;
      }
    }

    const lastStatementTokens = tokens.slice(statementStart, tokens.length);
    this.addStatement(lastStatementTokens);
  }

  getStatementByOffset(offset: number) {
    return this.statements.find((statement, i) => {
      const end = (this.statements[i + 1] ? this.statements[i + 1].range.start : statement.range.end);
      return (offset >= statement.range.start && offset < end) || (i === (this.statements.length - 1) && offset >= end);
    })
  }

  getTokenByOffset(offset: number): Token | undefined {
    const statement = this.getStatementByOffset(offset);

    if (statement) {
      return statement.getTokenByOffset(offset);
    }
  }

  getStatementGroups(): StatementGroup[] {
    let groups: StatementGroup[] = [];

    let currentGroup: Statement[] = [];

    let depth = 0;

    for (const statement of this.statements) {
        if (statement.isCompoundEnd()) {
          if (depth > 0) {
            currentGroup.push(statement);
              
            depth--;

            this.log(`<` + ``.padEnd(depth*2) + Statement.formatSimpleTokens(statement.tokens.slice(0, 2)));
          }

          if (depth === 0) {
            if (currentGroup.length > 0) {
              groups.push({
                range: { start: currentGroup[0].range.start, end: currentGroup[currentGroup.length-1].range.end },
                statements: currentGroup
              });

              currentGroup = [];
            }
          }
        } else
        if (statement.isCompoundStart()) {
          this.log(`>` + ``.padEnd(depth*2) + Statement.formatSimpleTokens(statement.tokens.slice(0, 2)));
          if (depth > 0) {
            currentGroup.push(statement);
          } else {
            currentGroup = [statement];
          }

          depth++;

        } else {
          this.log(` ` + ``.padEnd(depth*2) + Statement.formatSimpleTokens(statement.tokens.slice(0, 2)));
          if (depth > 0) {
            currentGroup.push(statement);
          } else {
            groups.push({
              range: statement.range,
              statements: [statement]
            });
          }
        }
    }

    if (currentGroup.length > 0) {
      groups.push({
        range: { start: currentGroup[0].range.start, end: currentGroup[currentGroup.length-1].range.end },
        statements: currentGroup
      });
    }

    return groups;
  }

  getDefinitions(): Definition[] {
    const groups = this.getStatementGroups();
    let list: Definition[] = [];

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];

      if (group.statements.length > 0) {
        if (group.statements.length === 1) {
          list.push(...getSymbolsForStatements(group.statements));

        } else {
          const [baseDef] = getSymbolsForStatements([group.statements[0]]);
          
          if (baseDef) {
            baseDef.children = getSymbolsForStatements(group.statements.slice(1))
          }

          list.push(baseDef);
        }
      }
    }

    return list;
  }

  getGroupByOffset(offset: number) {
    const groups = this.getStatementGroups();
    return groups.find((statement, i) => {
      const end = (groups[i + 1] ? groups[i + 1].range.start : statement.range.end);
      return (offset >= statement.range.start && offset < end) || (i === (groups.length - 1) && offset >= end);
    })
  }

  removeEmbeddedAreas(statement: Statement, options: {replacement: `snippet`|`?`|`values`, values?: any[]} = {replacement: `?`}): ParsedEmbeddedStatement {
    const areas = statement.getEmbeddedStatementAreas();

    const totalParameters = areas.filter(a => a.type === `marker`).length;
    let newContent = this.content.substring(statement.range.start, statement.range.end);
    let parameterCount = 0;

    const startRange = statement.range.start;

    // We do it in reverse so the substring ranges doesn't change
    for (let x = areas.length-1; x >= 0; x--) {
      const area = areas[x];

      let start = area.range.start - startRange, end = area.range.end - startRange;

      switch (area.type) {
        case `marker`:
          const markerContent = newContent.substring(start, end);

          switch (options.replacement) {
            case `snippet`:
              newContent = newContent.substring(0, start) + `\${${totalParameters-parameterCount}:${markerContent}}` + newContent.substring(end) + `$0`;
              break;
            case `?`:
              newContent = newContent.substring(0, start) + `?` + newContent.substring(end);
              break;
            case `values`:
              let valueIndex = totalParameters - parameterCount - 1;
              if (options.values && options.values.length > valueIndex) {
                let value = options.values[valueIndex];
                
                if (typeof value === `string`) {
                  value = `'${value.replace(/'/g, `''`)}'`; // Escape single quotes in strings
                }

                newContent = newContent.substring(0, start) + value + newContent.substring(end);
              } else {
                newContent = newContent.substring(0, start) + `?` + newContent.substring(end);
              }
              break;
          }
      
          parameterCount++;
          break;

        case `remove`:
          newContent = newContent.substring(0, start) + newContent.substring(end);
          if (newContent[start-1] === ` ` && newContent[start] === ` `) {
            newContent = newContent.substring(0, start-1) + newContent.substring(start);
          }
          break;
      }
    }

    return {
      changed: areas.length > 0,
      content: newContent.trim(),
      parameterCount
    };
  }
}


export function getPositionData(ref: CallableReference, offset: number) {
  const paramCommas = ref.tokens.filter(token => token.type === `comma`);

  let currentParm = paramCommas.findIndex(t => offset < t.range.start);

  if (currentParm === -1) {
    currentParm = paramCommas.length;
  }

  const firstNamedPipe = ref.tokens.find((token, i) => token.type === `rightpipe`);
  let firstNamedParameter = firstNamedPipe ? paramCommas.findIndex((token, i) => token.range.start > firstNamedPipe.range.start) : undefined;

  if (firstNamedParameter === -1) {
    firstNamedParameter = undefined;
  }

  return {
    currentParm,
    currentCount: paramCommas.length + 1,
    firstNamedParameter
  };
}

function getSymbolsForStatements(statements: Statement[]) {
  let defintions: Definition[] = [];

  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    const [objectRef] = statement.getObjectReferences();

    switch (statement.type) {
      case StatementType.Declare:
      case StatementType.Create:
        if (objectRef) {
          defintions.push({
            ...objectRef,
            children: [],
            range: statement.range
          });
        }
        break;
    }
  }

  return defintions;
}
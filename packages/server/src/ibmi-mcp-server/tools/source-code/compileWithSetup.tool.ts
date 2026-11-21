/**
 * Compile source with DB library setup
 * Creates a temporary CL program that calls DB setup then compiles
 */

import { z } from 'zod';
import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { JsonRpcErrorCode, McpError } from '../../../types-global/errors.js';
import type { RequestContext } from '../../../utils/index.js';
import { IBMiConnectionPool } from '../../services/connectionPool.js';
import { defineTool } from '../../../mcp-server/tools/utils/tool-factory.js';

// Input schema
const CompileWithSetupInputSchema = z.object({
  library: z.string().describe('Library containing source file'),
  source_file: z.string().describe('Source physical file name'),
  member: z.string().describe('Source member name to compile'),
  compile_type: z.enum(['RPGLE', 'SQLRPGLE', 'CLLE']).default('SQLRPGLE')
    .describe('Type of compilation: RPGLE, SQLRPGLE, or CLLE'),
  target_library: z.string().optional()
    .describe('Target library for compiled object (defaults to source library)'),
  setup_program: z.string().default('DB')
    .describe('Setup program to call before compilation (default: DB)'),
  setup_library: z.string().optional()
    .describe('Library containing setup program (defaults to source library)'),
});

type CompileWithSetupInput = z.infer<typeof CompileWithSetupInputSchema>;

/**
 * Logic for compile_with_setup tool
 */
export async function compileWithSetupLogic(
  input: CompileWithSetupInput,
  context: RequestContext,
): Promise<{ success: boolean; program: string; created: string; message: string }> {
  const { 
    library, 
    source_file, 
    member, 
    compile_type,
    target_library,
    setup_program,
    setup_library,
  } = input;

  const targetLib = target_library || library;
  const setupLib = setup_library || library;
  const tempMbr = `CMP${member.substring(0, 7)}`;

  // Build the compile command based on type
  let compileCmd = '';
  if (compile_type === 'SQLRPGLE') {
    compileCmd = `CRTSQLRPGI OBJ(${targetLib}/${member}) +
                            SRCFILE(${library}/${source_file}) +
                            SRCMBR(${member}) +
                            COMMIT(*NONE) +
                            DBGVIEW(*SOURCE) +
                            REPLACE(*YES)`;
  } else if (compile_type === 'RPGLE') {
    compileCmd = `CRTBNDRPG PGM(${targetLib}/${member}) +
                           SRCFILE(${library}/${source_file}) +
                           SRCMBR(${member}) +
                           DBGVIEW(*SOURCE) +
                           REPLACE(*YES)`;
  } else if (compile_type === 'CLLE') {
    compileCmd = `CRTCLPGM PGM(${targetLib}/${member}) +
                          SRCFILE(${library}/${source_file}) +
                          SRCMBR(${member}) +
                          REPLACE(*YES)`;
  }

  // Create CL source that calls setup then compiles
  const clSource = `PGM
             CALL       PGM(${setupLib}/${setup_program})
             MONMSG     MSGID(CPF0000)
             ${compileCmd}
             ENDPGM`;

  // Create source file in QTEMP if it doesn't exist
  try {
    await IBMiConnectionPool.executeQuery(
      `CALL QSYS2.QCMDEXC('CRTSRCPF FILE(QTEMP/QCLSRC) RCDLEN(112) MBR(${tempMbr})')`,
      [],
      context,
    );
  } catch {
    // File might exist - try adding member
    try {
      await IBMiConnectionPool.executeQuery(
        `CALL QSYS2.QCMDEXC('ADDPFM FILE(QTEMP/QCLSRC) MBR(${tempMbr}) SRCTYPE(CLP)')`,
        [],
        context,
      );
    } catch {
      // Member might exist - clear it
      await IBMiConnectionPool.executeQuery(
        `CALL QSYS2.QCMDEXC('CLRPFM FILE(QTEMP/QCLSRC) MBR(${tempMbr})')`,
        [],
        context,
      );
    }
  }

  // Write CL source line by line using OVRDBF
  const lines = clSource.split('\n');

  // Override database file to target specific member
  await IBMiConnectionPool.executeQuery(
    `CALL QSYS2.QCMDEXC('OVRDBF FILE(QCLSRC) TOFILE(QTEMP/QCLSRC) MBR(${tempMbr})')`,
    [],
    context,
  );

  try {
    for (let i = 0; i < lines.length; i++) {
      const seq = (i + 1) * 100;
      const line = (lines[i] || '').substring(0, 100);
      await IBMiConnectionPool.executeQuery(
        `INSERT INTO QTEMP.QCLSRC (SRCSEQ, SRCDAT, SRCDTA) VALUES (?, ?, ?)`,
        [seq, 0, line],
        context,
      );
    }
  } finally {
    // Delete override
    try {
      await IBMiConnectionPool.executeQuery(
        `CALL QSYS2.QCMDEXC('DLTOVR FILE(QCLSRC)')`,
        [],
        context,
      );
    } catch {
      // Ignore
    }
  }

  // Create the CL program
  await IBMiConnectionPool.executeQuery(
    `CALL QSYS2.QCMDEXC('CRTCLPGM PGM(QTEMP/${tempMbr}) SRCFILE(QTEMP/QCLSRC) SRCMBR(${tempMbr}) REPLACE(*YES)')`,
    [],
    context,
  );

  // Execute the CL program (which calls DB then compiles)
  try {
    await IBMiConnectionPool.executeQuery(
      `CALL QSYS2.QCMDEXC('CALL PGM(QTEMP/${tempMbr})')`,
      [],
      context,
    );
  } catch (err) {
    // Even if QCMDEXC reports an error, the program might have compiled
    // Check if program exists below
  }

  // Verify the program was created
  const verifyResult = await IBMiConnectionPool.executeQuery(
    `SELECT OBJNAME, OBJTYPE, OBJCREATED, OBJSIZE 
     FROM TABLE(QSYS2.OBJECT_STATISTICS(?, '*PGM', ?))`,
    [targetLib, member],
    context,
  );

  if (verifyResult.data && verifyResult.data.length > 0) {
    const pgm = verifyResult.data[0] as any;
    return {
      success: true,
      program: `${targetLib}/${member}`,
      created: pgm.OBJCREATED,
      message: `Program ${member} compiled successfully with ${setup_program} setup`,
    };
  } else {
    throw new McpError(
      JsonRpcErrorCode.InternalError,
      `Compilation failed - program ${member} not created in ${targetLib}`,
    );
  }
}

// Output schema
const CompileWithSetupOutputSchema = z.object({
  success: z.boolean(),
  program: z.string(),
  created: z.string(),
  message: z.string(),
});

/**
 * Response formatter
 */
function compileWithSetupResponseFormatter(
  result: z.infer<typeof CompileWithSetupOutputSchema>,
): ContentBlock[] {
  return [
    {
      type: 'text',
      text: JSON.stringify(result, null, 2),
    },
  ];
}

/**
 * Tool definition
 */
export const compileWithSetupTool = defineTool({
  name: 'compile_with_setup',
  title: 'Compile With Library Setup',
  description:
    'Compile RPG/SQL RPG/CL source with library setup program (e.g., DB). Creates a temporary CL program that calls the setup program then compiles the source. This ensures the library list is properly configured before compilation.',
  inputSchema: CompileWithSetupInputSchema,
  outputSchema: CompileWithSetupOutputSchema,
  logic: compileWithSetupLogic,
  responseFormatter: compileWithSetupResponseFormatter,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
});

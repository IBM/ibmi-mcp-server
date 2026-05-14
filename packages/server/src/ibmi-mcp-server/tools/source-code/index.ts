/**
 * Source Code Tools
 *
 * IBM i source code access, compilation, and debugging tools.
 *
 * @module source-code
 */

export { readSourceMemberTool } from "./readSourceMember.tool.js";
export { writeSourceMemberTool } from "./writeSourceMember.tool.js";
export { compileSourceTool } from "./compileSource.tool.js";
export { getCompileErrorsTool } from "./getCompileErrors.tool.js";
export { readSpoolFileTool } from "./readSpoolFile.tool.js";
export { compileWithSetupTool } from "./compileWithSetup.tool.js";
// Temporarily disabled - has TypeScript errors
// export { writeSourceToIfsTool } from "./writeSourceToIfs.tool.js";
// export { compileFromIfsTool } from "./compileFromIfs.tool.js";

// Export logic functions for direct use
export { readSourceMemberLogic } from "./readSourceMember.tool.js";
export { writeSourceMemberLogic } from "./writeSourceMember.tool.js";
export { compileSourceLogic } from "./compileSource.tool.js";
export { getCompileErrorsLogic } from "./getCompileErrors.tool.js";
export { readSpoolFileLogic } from "./readSpoolFile.tool.js";
export { compileWithSetupLogic } from "./compileWithSetup.tool.js";
// Temporarily disabled - has TypeScript errors
// export { writeSourceToIfsLogic } from "./writeSourceToIfs.tool.js";
// export { compileFromIfsLogic } from "./compileFromIfs.tool.js";

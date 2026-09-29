# IBM i Source Code Tools

TypeScript-based tools for AI-assisted source code access, compilation, and debugging on IBM i.

## Overview

These tools enable AI agents to:
- **Read** source code from IBM i source files
- **Compile** RPG, CL, and COBOL programs
- **Retrieve** compilation errors from job logs

## Tools

### 1. read_source_member

Reads IBM i source code from a source physical file member.

**Input:**
```typescript
{
  library: string;        // Library containing the source (e.g., 'MYLIB')
  source_file: string;    // Source file name (e.g., 'QRPGLESRC')
  member: string;         // Member name (e.g., 'MYPGM')
  include_line_numbers?: boolean;  // Default: true
}
```

**Output:**
- Source code with line numbers
- Metadata (source type, line count, last modified)
- Execution time

**Example:**
```
Input: { library: 'MYLIB', source_file: 'QRPGLESRC', member: 'MYPGM' }
Output: Complete source code with metadata
```

### 2. compile_source

Compiles IBM i source code into modules or programs.

**Input:**
```typescript
{
  library: string;          // Library with source
  source_file: string;      // Source file name
  member: string;           // Member to compile
  target_library?: string;  // Where to put compiled object
  compile_type: 'RPGLE' | 'SQLRPGLE' | 'CL' | 'CLLE' | 'CBL' | 'CBLLE';
  compile_options?: string; // Additional options (e.g., 'DBGVIEW(*SOURCE)')
  create_program?: boolean; // Create program vs module (default: false)
}
```

**Output:**
- Success/failure status
- Compile command executed
- Job information
- Execution time

**Example:**
```
Input: { library: 'MYLIB', source_file: 'QRPGLESRC', member: 'MYPGM', compile_type: 'RPGLE' }
Output: Compilation status and job details
```

### 3. get_compile_errors

Retrieves compilation error messages from the current job log.

**Input:**
```typescript
{
  min_severity?: number;           // Minimum severity (0-99), default: 20
  max_messages?: number;           // Max messages to return, default: 100
  message_type_filter?: string[];  // Filter by message types
}
```

**Output:**
- Array of error messages with:
  - Message ID (e.g., RNF7030)
  - Severity level
  - Message text
  - Detailed help text
  - Source program/library

**Example:**
```
Input: { min_severity: 30, max_messages: 50 }
Output: List of errors and warnings from recent compile
```

## Configuration

### Enable Source Code Tools

**Environment Variable:**
```bash
IBMI_ENABLE_SOURCE_TOOLS=true
```

**In .env file:**
```bash
# Enable source code tools
IBMI_ENABLE_SOURCE_TOOLS=true

# Note: compile_source requires write access
IBMI_EXECUTE_SQL_READONLY=false  # ⚠️ Security: enables write operations
```

### Security Considerations

- **read_source_member**: Read-only, safe for production
- **compile_source**: Requires write access (IBMI_EXECUTE_SQL_READONLY=false)
- **get_compile_errors**: Read-only, safe for production

⚠️ **Only enable in development/test environments** unless you have strict security controls.

## Usage Example

### AI-Assisted Compile Workflow

```
1. Agent: "Read source for MYPGM"
   Tool: read_source_member

2. Agent: "Compile this program"
   Tool: compile_source

3. If compile fails:
   Tool: get_compile_errors
   
4. Agent analyzes errors and suggests fixes

5. Agent: "Update source with fixes"
   (Would use update_source_member - not yet implemented)

6. Repeat until successful
```

## Implementation Details

- **Pattern**: Single-file .tool.ts following factory pattern
- **Error Handling**: McpError with proper error codes
- **Logging**: Structured logging with RequestContext
- **Database Access**: Via IBMiConnectionPool
- **Response Formatting**: Custom formatters for each tool

## Related Documentation

- [SOURCE_CODE_TOOLS_DESIGN.md](../../../../../../SOURCE_CODE_TOOLS_DESIGN.md) - Complete design specification
- [SOURCE_CODE_TOOLS_SUMMARY.md](../../../../../../SOURCE_CODE_TOOLS_SUMMARY.md) - Quick reference
- [packages/server/README.md](../../../../README.md) - Server documentation

## Future Enhancements

- **update_source_member**: Modify source code programmatically
- **get_spool_file_content**: Read detailed compile listings
- **create_source_member**: Create new source members
- **AI compile loop**: Automated compile-fix-recompile orchestration

## Testing

Run tests:
```bash
npm test -- packages/server/src/ibmi-mcp-server/tools/source-code/
```

## Contributing

When adding new tools:
1. Create .tool.ts file following existing pattern
2. Export from index.ts
3. Add to getAllToolDefinitions() in parent index.ts
4. Update this README
5. Add tests

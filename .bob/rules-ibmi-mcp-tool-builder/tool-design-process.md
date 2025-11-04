# SQL Tool Design Process

## Overview

This document outlines the step-by-step process for creating effective, secure, and well-structured SQL tools for IBM i MCP Server. Following this process ensures that your tools meet the project's standards, are properly validated, and provide maximum value to users.

## Process Flow

### 1. Define Intent and Research Use Case

**Objective**: Clearly understand the purpose and requirements of the SQL tool.

#### Steps:
1. **Identify the agentic use case**
   - Ask the user to describe their specific use case
   - Determine if the tool is for administration, performance monitoring, development, or another purpose
   - Identify the target users and their technical expertise level

2. **Ask clarifying questions**
   - What specific IBM i data or functionality does the user need to access?
   - What parameters should be configurable by the end user?
   - Are there performance considerations or security constraints?
   - What is the expected output format and usage pattern?

3. **Research available IBM i services**
   - Use the `ibmi-mcp-docs` MCP server to search for relevant documentation on the MCP server
   - Use the `ibmi-mcp-server` tools to explore available SQL services:
     ```
     - list_service_categories
     - list_services_by_category
     - search_services_by_name
     - list_services_by_schema
     ```
   - Identify the most appropriate IBM i SQL services for the use case

4. **Document requirements**
   - Summarize the tool's purpose and requirements
   - List the IBM i SQL services that will be used
   - Outline the parameters that will be exposed to users
   - Define the expected output format and structure

### 2. Define SQL Statements

**Objective**: Create precise, efficient, and secure SQL statements.

#### Steps:
1. **Fetch relevant metadata**
   - Use `ibmi-mcp-server` tools to retrieve column information:
     ```
     - list_tables_by_schema
     - describe_object
     ```
   - Verify table and column names exist in the IBM i system
   - **IMPORTANT**: Do not hallucinate columns, tables, or functions

2. **Draft SQL statements**
   - Start with simple queries and build complexity
   - Use parameter placeholders (`:param_name`) for all user inputs
   - Apply appropriate filtering and sorting
   - Consider performance implications for large result sets
   - Add row limits for queries that could return large results

3. **Optimize SQL**
   - Review for efficiency and readability
   - Consider indexing requirements
   - Use appropriate SQL functions and operators
   - Ensure compatibility with IBM i Db2 SQL dialect

### 3. Present Raw SQL for Inspection

**Objective**: Allow the user to review and validate the SQL statements.

#### Steps:
1. **Present SQL statements**
   - Show the complete SQL statements with parameter placeholders
   - Explain the purpose and expected results of each statement
   - Highlight any performance considerations or limitations

2. **Validate SQL syntax**
   - Ensure the SQL is valid Db2 for i SQL
   - Check for proper use of IBM i-specific functions and syntax
   - Verify parameter binding is used consistently

3. **Gather feedback**
   - Ask the user to review the SQL statements
   - Make adjustments based on user feedback
   - Confirm the SQL meets the requirements

### 4. Generate YAML Configuration

**Objective**: Create a properly structured YAML file following the schema.

#### Steps:
1. **Read schema and examples**
   - Review the SQL tools schema at `server/src/ibmi-mcp-server/schemas/json/sql-tools-config.json`
   - Examine example tool files in the `tools/` directory
   - Understand the required and optional fields

2. **Structure the YAML file**
   - Define sources section with connection parameters
   - Create tools section with individual tool definitions
   - Add parameters with proper validation constraints
   - Configure security settings (default to read-only)
   - Add appropriate annotations
   - Group related tools into logical toolsets

3. **Apply naming conventions**
   - Use snake_case for tool and parameter names
   - Follow verb-noun pattern for tool names
   - Use descriptive names that clearly indicate purpose

4. **Add documentation**
   - Write clear, concise descriptions for tools and parameters
   - Include examples in parameter descriptions
   - Document any limitations or special considerations

### 5. Generate and Save the YAML File

**Objective**: Create and save the YAML file in the appropriate location.

#### Steps:
1. **Determine file location**
   - Ask the user where to save the file
   - Default to `tools-tmp/` if no preference is specified
   - Use a descriptive filename that indicates the purpose

2. **Generate the file**
   - Create the complete YAML file with all required sections
   - Ensure proper indentation and formatting
   - Include comments for clarity if needed

3. **Save the file**
   - Write the file to the specified location
   - Confirm successful file creation

### 6. Validate and Address Errors

**Objective**: Ensure the YAML file is valid and meets all requirements.

#### Steps:
1. **Run validation**
   - Execute the validation script:
     ```bash
     npm run validate -- --tools <file.yaml>
     ```
   - Review validation output for errors or warnings

2. **Address issues**
   - Fix any schema validation errors
   - Correct naming convention violations
   - Resolve security configuration issues
   - Update SQL statements if needed

3. **Re-validate**
   - Run validation again after making changes
   - Continue until all errors are resolved

4. **Final review**
   - Perform a final review of the YAML file
   - Ensure all requirements are met
   - Confirm the tool is ready for use

### 7. Test the Tool

**Objective**: Ensure the tool is functioning as expected.

#### Steps:
1. **Generate a valid command to start server over http**
 ```bash
 npx ibmi-mcp-server --tools <file.yaml> --tansport http
 ```
 - Either start the command, or let the user run the command manually

## Best Practices

### SQL Statement Design
- Always use parameter binding (`:param_name`) for user inputs
- Include appropriate `WHERE` clauses to limit results
- Add `FETCH FIRST n ROWS ONLY` for queries that could return large results
- Use column lists instead of `SELECT *` when possible
- Format SQL for readability with proper indentation

### Parameter Design
- Make parameters required only when absolutely necessary
- Provide sensible defaults when possible
- Include clear descriptions with examples
- Use appropriate validation constraints (min/max, enum, pattern)
- Consider the user experience when defining parameters

### Security Considerations
- Default to read-only operations (`readOnly: true`)
- Avoid destructive operations (DELETE, DROP, UPDATE) when possible
- Clearly mark non-read-only operations with appropriate annotations
- Consider authority requirements and document them
- Limit result sets to prevent performance issues

### Documentation
- Write clear, concise descriptions
- Explain both the purpose and the output format
- Document any limitations or special considerations
- Include examples when helpful
- Use consistent terminology

## Example Workflow

Here's an example of the complete workflow:

1. **Define Intent**: Create a tool to monitor active jobs on an IBM i system
2. **Research**: Identify QSYS2.ACTIVE_JOB_INFO as the appropriate service
3. **Define SQL**:
   ```sql
   SELECT * FROM TABLE(QSYS2.ACTIVE_JOB_INFO(
     JOB_NAME_FILTER => :job_name,
     JOB_USER_FILTER => :job_user,
     JOB_TYPE_FILTER => :job_type
   )) AS X
   ORDER BY CPU_TIME DESC
   FETCH FIRST 100 ROWS ONLY
   ```
4. **Present SQL** for user review and validation
5. **Generate YAML**:
   ```yaml
   tools:
     find_active_jobs:
       source: ibmi
       description: "Find active jobs on the system matching specified criteria"
       statement: |
         SELECT * FROM TABLE(QSYS2.ACTIVE_JOB_INFO(
           JOB_NAME_FILTER => :job_name,
           JOB_USER_FILTER => :job_user,
           JOB_TYPE_FILTER => :job_type
         )) AS X
         ORDER BY CPU_TIME DESC
         FETCH FIRST 100 ROWS ONLY
       parameters:
         - name: job_name
           type: string
           description: "Job name filter (e.g., 'QZDASOINIT', '*ALL')"
           default: "*ALL"
         - name: job_user
           type: string
           description: "Job user filter (e.g., 'QUSER', '*ALL')"
           default: "*ALL"
         - name: job_type
           type: string
           description: "Job type filter (e.g., 'BATCH', 'INTER', '*ALL')"
           default: "*ALL"
       security:
         readOnly: true
       annotations:
         readOnlyHint: true
         idempotentHint: true
         domain: "system"
         category: "jobs"
   ```
6. **Save** to `tools-tmp/job-monitoring.yaml`
7. **Validate** with `npm run validate -- --tools tools-tmp/job-monitoring.yaml`
8. **Address** any validation errors
9. **Finalize** the tool definition

By following this process, you'll create high-quality, secure, and effective SQL tools that follow best practices and meet the project's standards.
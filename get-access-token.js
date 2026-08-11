#!/usr/bin/env node
/**
 * Simple test script for IBM i HTTP Authentication endpoint
 * Tests the POST /api/v1/auth endpoint with user credentials
 *
 * Loads credentials from DB2i_* environment variables, with CLI fallback.
 * Set MCP_SERVER_CONFIG to load a dotenv file (local development only).
 * Sets IBMI_MCP_ACCESS_TOKEN environment variable on success.
 *
 * Usage: node get-access-token.js [--user <username>] [--password <password>] [--host <ibmi-host>] [--verbose] [--https]
 */

import https from "https";
import http from "http";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createCipheriv, publicEncrypt, randomBytes } from "node:crypto";

// Load a dotenv file only when MCP_SERVER_CONFIG is explicitly set.
if (process.env.MCP_SERVER_CONFIG) {
  const configPath = resolve(process.env.MCP_SERVER_CONFIG);
  if (!existsSync(configPath)) {
    throw new Error(
      `MCP_SERVER_CONFIG is set to "${configPath}" but the file does not exist.`,
    );
  }
  dotenv.config({ path: configPath });
}

// Parse command line arguments
const options = {
  user: {
    type: "string",
    short: "u",
    description: "IBM i username (defaults to DB2i_USER)",
  },
  password: {
    type: "string",
    short: "p",
    description: "IBM i password (defaults to DB2i_PASS)",
  },
  host: {
    type: "string",
    short: "h",
    description: "IBM i host address (defaults to DB2i_HOST)",
  },
  verbose: {
    type: "boolean",
    short: "v",
    description: "Enable verbose output with metadata",
    default: false,
  },
  https: {
    type: "boolean",
    description: "Use HTTPS instead of HTTP",
    default: false,
  },
  quiet: {
    type: "boolean",
    short: "q",
    description: "Output only export command for shell evaluation",
    default: false,
  },
  server: {
    type: "string",
    description: "MCP server address",
    default: "localhost",
  },
  port: {
    type: "string",
    description: "MCP server port",
    default: "3010",
  },
  duration: {
    type: "string",
    description: "Token duration in seconds",
    default: "7200",
  },
  "pool-start": {
    type: "string",
    description: "Initial pool size",
    default: "2",
  },
  "pool-max": {
    type: "string",
    description: "Maximum pool size",
    default: "5",
  },
  "public-key-path": {
    type: "string",
    description: "Path to PEM-encoded server public key (skips HTTP fetch)",
  },
  "key-id": {
    type: "string",
    description: "Key identifier to use when --public-key-path is provided",
  },
};

let args;
try {
  const parsed = parseArgs({ options, allowPositionals: false });
  args = parsed.values;
} catch (error) {
  console.error("❌ Error parsing arguments:", error.message);
  console.error(
    "\nUsage: node test-auth.js --user <username> --password <password> --host <ibmi-host> [--verbose] [--https]",
  );
  console.error("\nOptions:");
  Object.entries(options).forEach(([key, opt]) => {
    const shortFlag = opt.short ? `-${opt.short}, ` : "";
    console.error(`  ${shortFlag}--${key}\t${opt.description}`);
  });
  process.exit(1);
}

// Load credentials from environment variables with CLI fallback
const credentials = {
  user: args.user || process.env.DB2i_USER,
  password: args.password || process.env.DB2i_PASS,
  host: args.host || process.env.DB2i_HOST,
};

// Determine credential source for messaging
const credentialSource = {
  user: args.user
    ? "CLI argument"
    : process.env.DB2i_USER
      ? "environment DB2i_USER"
      : "missing",
  password: args.password
    ? "CLI argument"
    : process.env.DB2i_PASS
      ? "environment DB2i_PASS"
      : "missing",
  host: args.host
    ? "CLI argument"
    : process.env.DB2i_HOST
      ? "environment DB2i_HOST"
      : "missing",
};

// Print credential source information
if (args.verbose) {
  console.log("🔑 Using credentials from:");
  console.log(`   User: ${credentialSource.user}`);
  console.log(`   Password: ${credentialSource.password}`);
  console.log(`   Host: ${credentialSource.host}`);
  console.log();
}

// Validate required credentials
if (!credentials.user || !credentials.password || !credentials.host) {
  const missing = [];
  if (!credentials.user) missing.push("user");
  if (!credentials.password) missing.push("password");
  if (!credentials.host) missing.push("host");

  console.error(`❌ Missing required credentials: ${missing.join(", ")}`);
  console.error("\n📝 Solutions:");
  console.error(
    "   1. Set environment variables: DB2i_USER=<user> DB2i_PASS=<pass> DB2i_HOST=<host>",
  );
  console.error(
    "   2. Use CLI args: --user <user> --password <pass> --host <host>",
  );
  console.error(
    "\nUsage: node get-access-token.js [--user <username>] [--password <password>] [--host <ibmi-host>] [--verbose] [--https]",
  );
  process.exit(1);
}

// Test configuration
const TEST_CONFIG = {
  server: args.server,
  port: parseInt(args.port, 10),
  path: "/api/v1/auth",
  username: credentials.user,
  password: credentials.password,
  useHttps: args.https,
  verbose: args.verbose,
};

const ibmiHost = credentials.host;

if (TEST_CONFIG.verbose) {
  console.log("🧪 Testing IBM i HTTP Authentication Endpoint");
  console.log(
    `   Endpoint: ${TEST_CONFIG.useHttps ? "https" : "http"}://${TEST_CONFIG.server}:${TEST_CONFIG.port}${TEST_CONFIG.path}`,
  );
  console.log(`   IBM i Host: ${ibmiHost}`);
  console.log(`   Username: ${TEST_CONFIG.username}`);
  console.log(`   Password: ${"*".repeat(TEST_CONFIG.password.length)}`);
  console.log();

  if (!TEST_CONFIG.useHttps) {
    console.log("⚠️  Using HTTP - TLS enforcement may reject this request");
    console.log("💡 To allow HTTP in development, start the server with:");
    console.log(
      "   IBMI_HTTP_AUTH_ENABLED=true IBMI_AUTH_ALLOW_HTTP=true npm start",
    );
    console.log("💡 Or test with HTTPS: add --https flag");
    console.log();
  }
}

const httpModule = TEST_CONFIG.useHttps ? https : http;

function toBase64(buffer) {
  return Buffer.from(buffer).toString("base64");
}

async function readPublicKeyFromFile(path, keyId) {
  const publicKey = await readFile(path, "utf8");
  if (!keyId) {
    throw new Error(
      "--key-id is required when using --public-key-path to identify the server key",
    );
  }
  return { keyId, publicKey };
}

async function fetchPublicKeyFromServer() {
  return new Promise((resolve, reject) => {
    const req = httpModule.request(
      {
        hostname: TEST_CONFIG.server,
        port: TEST_CONFIG.port,
        path: "/api/v1/auth/public-key",
        method: "GET",
        headers: { Accept: "application/json" },
        rejectUnauthorized: false,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(
              new Error(
                `Failed to fetch public key: ${res.statusCode} ${res.statusMessage}`,
              ),
            );
          }
          try {
            const parsed = JSON.parse(body);
            if (!parsed.keyId || !parsed.publicKey) {
              throw new Error("Response missing keyId or publicKey");
            }
            resolve({ keyId: parsed.keyId, publicKey: parsed.publicKey });
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on("error", (err) => reject(err));
    req.end();
  });
}

async function resolvePublicKey() {
  if (args["public-key-path"]) {
    try {
      return await readPublicKeyFromFile(
        args["public-key-path"],
        args["key-id"],
      );
    } catch (error) {
      console.error("Failed to read public key from file:", error.message);
      process.exit(1);
    }
  }

  try {
    return await fetchPublicKeyFromServer();
  } catch (error) {
    console.error("Failed to fetch public key:", error.message);
    process.exit(1);
  }
}

function encryptPayload(publicKeyMetadata) {
  const sessionKey = randomBytes(32);
  const iv = randomBytes(12);

  const payload = {
    credentials: {
      username: TEST_CONFIG.username,
      password: TEST_CONFIG.password,
    },
    request: {
      host: ibmiHost,
      duration: parseInt(args.duration, 10),
      poolstart: parseInt(args["pool-start"], 10),
      poolmax: parseInt(args["pool-max"], 10),
    },
  };

  const cipher = createCipheriv("aes-256-gcm", sessionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const encryptedSessionKey = publicEncrypt(
    {
      key: publicKeyMetadata.publicKey,
      oaepHash: "sha256",
    },
    sessionKey,
  );

  return {
    keyId: publicKeyMetadata.keyId,
    encryptedSessionKey: toBase64(encryptedSessionKey),
    iv: toBase64(iv),
    authTag: toBase64(authTag),
    ciphertext: toBase64(ciphertext),
  };
}

async function main() {
  const publicKeyMetadata = await resolvePublicKey();

  if (TEST_CONFIG.verbose) {
    console.log("🔐 Using server public key:");
    console.log(`   Key ID: ${publicKeyMetadata.keyId}`);
    console.log("   PEM snippet:");
    console.log(
      publicKeyMetadata.publicKey.split("\n").slice(0, 2).join("\n") + "\n...",
    );
  }

  const envelope = encryptPayload(publicKeyMetadata);
  const requestData = JSON.stringify(envelope);

  const requestOptions = {
    hostname: TEST_CONFIG.server,
    port: TEST_CONFIG.port,
    path: TEST_CONFIG.path,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(requestData),
    },
    rejectUnauthorized: false,
  };

  if (TEST_CONFIG.verbose) {
    console.log("📤 Sending authentication request...");
  }

  const req = httpModule.request(requestOptions, (res) => {
    if (TEST_CONFIG.verbose) {
      console.log(`📥 Response Status: ${res.statusCode} ${res.statusMessage}`);
      console.log("📥 Response Headers:");
      Object.entries(res.headers).forEach(([key, value]) => {
        console.log(`   ${key}: ${value}`);
      });
      console.log();
    }

    let responseBody = "";
    res.on("data", (chunk) => {
      responseBody += chunk;
    });

    res.on("end", () => {
      try {
        const parsedResponse = JSON.parse(responseBody);
        const isSuccess = res.statusCode === 201;
        const token = parsedResponse.access_token;

        if (TEST_CONFIG.verbose) {
          console.log("📥 Response Body:");
          console.log(JSON.stringify(parsedResponse, null, 2));
        } else if (!args.quiet) {
          console.log(JSON.stringify(parsedResponse, null, 2));
        }

        if (isSuccess && token) {
          process.env.IBMI_MCP_ACCESS_TOKEN = token;

          if (args.quiet) {
            console.log(`export IBMI_MCP_ACCESS_TOKEN="${token}"`);
            return;
          }

          if (TEST_CONFIG.verbose) {
            console.log();
            console.log("✅ Authentication successful!");
            console.log(`   Token: ${token.substring(0, 20)}...`);
            console.log(`   Expires: ${parsedResponse.expires_at}`);
            console.log(`   Duration: ${parsedResponse.expires_in} seconds`);

            console.log();
            console.log("🔍 Token details:");
            console.log(`   Length: ${token.length} bytes`);
            console.log(`   Type: ${parsedResponse.token_type}`);

            console.log();
            console.log(
              "🔧 IBMI_MCP_ACCESS_TOKEN set for this process. To export in your shell:",
            );
            console.log(`   export IBMI_MCP_ACCESS_TOKEN="${token}"`);
            console.log();
            console.log("🚀 Or evaluate automatically:");
            console.log("   eval $(node get-access-token.js --quiet)");
          } else {
            console.log(
              "✅ Authentication successful. Token stored in IBMI_MCP_ACCESS_TOKEN.",
            );
          }
          return;
        }

        // handle failure path
        console.log();
        console.log("❌ Authentication failed!");
        if (parsedResponse.error) {
          console.log(`   Error Code: ${parsedResponse.error.code}`);
          console.log(`   Error Message: ${parsedResponse.error.message}`);

          if (parsedResponse.error.message?.includes("HTTPS/TLS is required")) {
            console.log();
            console.log(
              "💡 TLS enforcement is active. Allow HTTP in development (IBMI_AUTH_ALLOW_HTTP=true) or rerun with --https.",
            );
          }
        }
      } catch (parseError) {
        if (TEST_CONFIG.verbose) {
          console.log("Raw response:", responseBody);
          console.log("❌ Failed to parse JSON response:", parseError.message);
        } else {
          console.error(
            JSON.stringify(
              { error: "Failed to parse JSON response", raw: responseBody },
              null,
              2,
            ),
          );
        }
        process.exit(1);
      }
    });
  });

  req.on("error", (error) => {
    if (TEST_CONFIG.verbose) {
      console.log("❌ Request failed:", error.message);

      if (error.code === "ECONNREFUSED") {
        console.log("💡 Make sure the server is running with:");
        console.log("   IBMI_HTTP_AUTH_ENABLED=true npm start");
      }

      if (
        error.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" &&
        TEST_CONFIG.useHttps
      ) {
        console.log(
          "💡 For HTTPS testing, add --https flag for insecure connections",
        );
      }
    } else {
      console.error(
        JSON.stringify({ error: error.message, code: error.code }, null, 2),
      );
    }
    process.exit(1);
  });

  req.write(requestData);
  req.end();

  if (TEST_CONFIG.verbose) {
    console.log("⏳ Waiting for response...");
  }
}

void main();

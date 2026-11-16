/**
 * Tests the TLS listener of the HTTP transport (MCP_TLS_CERT_FILE and
 * MCP_TLS_KEY_FILE): the real transport on a loopback port, with a
 * certificate generated for the test.
 *
 * @module tests/mcp-server/transports/http/tlsListener.test
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { config } from "../../../../src/config/index.js";
import { startHttpTransport } from "../../../../src/mcp-server/transports/http/index.js";
import { JsonRpcErrorCode } from "../../../../src/types-global/errors.js";
import { logger, requestContextService } from "../../../../src/utils/index.js";
import { generateCertificates } from "../../../ibmi-mcp-server/oauth/fakeMapepire.js";

const saved = {
  mcpHttpHost: config.mcpHttpHost,
  mcpHttpPort: config.mcpHttpPort,
  mcpAuthMode: config.mcpAuthMode,
  mcpTlsCertFile: config.mcpTlsCertFile,
  mcpTlsKeyFile: config.mcpTlsKeyFile,
  ibmiHttpAuthEnabled: config.ibmiHttpAuth.enabled,
};

let directory: string;
let certFile: string;
let keyFile: string;
let certPem: string;
let transport: { close(): Promise<void> } | undefined;

const start = async () => {
  transport = await startHttpTransport(
    () => new McpServer({ name: "tls-listener-test", version: "0.0.0" }),
    requestContextService.createRequestContext({
      operation: "tlsListenerTest",
    }),
  );
};

/** A port nothing is listening on. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** GET /healthz over TLS, trusting only the test certificate. */
const getOverTls = () =>
  new Promise<{ status?: number; body: string }>((resolve, reject) => {
    https
      .get(
        `https://127.0.0.1:${config.mcpHttpPort}/healthz`,
        { ca: certPem, agent: false },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode, body }),
          );
        },
      )
      .on("error", reject);
  });

/** GET /healthz without TLS; resolves to the status if the server answers. */
const getInTheClear = () =>
  new Promise<number | undefined>((resolve, reject) => {
    http
      .get(
        `http://127.0.0.1:${config.mcpHttpPort}/healthz`,
        { agent: false },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      )
      .on("error", reject);
  });

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "ibmi-mcp-tls-"));
  certFile = join(directory, "server.crt");
  keyFile = join(directory, "server.key");
  const certificate = generateCertificates(["127.0.0.1", "localhost"]);
  // The client trusts the CA that issued the listener's certificate.
  certPem = certificate.caPem;
  writeFileSync(certFile, certificate.certPem);
  writeFileSync(keyFile, certificate.keyPem);
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  config.mcpHttpHost = "127.0.0.1";
  config.mcpHttpPort = await freePort();
  config.mcpAuthMode = "none";
  config.mcpTlsCertFile = certFile;
  config.mcpTlsKeyFile = keyFile;
  config.ibmiHttpAuth.enabled = false;
});

afterEach(async () => {
  await transport?.close();
  transport = undefined;
  vi.restoreAllMocks();
  const { ibmiHttpAuthEnabled, ...rest } = saved;
  Object.assign(config, rest);
  config.ibmiHttpAuth.enabled = ibmiHttpAuthEnabled;
});

describe("HTTP transport with MCP_TLS_CERT_FILE and MCP_TLS_KEY_FILE", () => {
  it("serves /healthz over https with the configured certificate", async () => {
    await start();

    const response = await getOverTls();

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ status: "ok" });
  });

  it("does not answer a request that is not TLS", async () => {
    await start();

    await expect(getInTheClear()).rejects.toThrow();
  });

  it("logs the address it listens at with the https scheme", async () => {
    const info = vi.spyOn(logger, "info");

    await start();

    expect(info).toHaveBeenCalledWith(
      expect.anything(),
      `HTTP transport listening at https://127.0.0.1:${config.mcpHttpPort}/mcp`,
    );
  });

  it("listens without TLS when the files are not set", async () => {
    config.mcpTlsCertFile = undefined;
    config.mcpTlsKeyFile = undefined;

    await start();

    expect(await getInTheClear()).toBe(200);
    await expect(getOverTls()).rejects.toThrow();
  });

  it.each([
    ["MCP_TLS_CERT_FILE", "mcpTlsCertFile"],
    ["MCP_TLS_KEY_FILE", "mcpTlsKeyFile"],
  ] as const)(
    "refuses to start when %s cannot be read, naming it",
    async (name, setting) => {
      const file = join(directory, "missing.pem");
      config[setting] = file;

      await expect(start()).rejects.toMatchObject({
        code: JsonRpcErrorCode.ConfigurationError,
        message: `${name}: cannot read ${file} (ENOENT). Set ${name} to a file this process can read.`,
      });
    },
  );

  it("refuses to start when the files do not hold a certificate and its key", async () => {
    const notAKey = join(directory, "not-a-key.pem");
    writeFileSync(notAKey, "not a private key\n");
    config.mcpTlsKeyFile = notAKey;

    await expect(start()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: expect.stringMatching(
        /^MCP_TLS_CERT_FILE and MCP_TLS_KEY_FILE must hold a PEM certificate and its private key \(.+\)\.$/,
      ),
    });
  });
});

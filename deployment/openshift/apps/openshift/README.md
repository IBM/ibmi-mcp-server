# OpenShift Deployment

This directory contains Kubernetes/OpenShift manifests for deploying IBM i MCP Server and MCP Context Forge using Kustomize.

## Overview

The applications are deployed on OpenShift using a source-to-image (S2I) build strategy. With this strategy, the application can be built from source in a remote repository or local development environment. The deployment of MCP Context Forge is configured with an ImageStreamTag trigger; any new image build will trigger the application re-deployment.

## Prerequisites

1. OpenShift cluster access
2. `oc` CLI tool installed
3. Kustomize installed
4. A `.env` file in the `mcp-context-forge/` and `ibmi-mcp-server` directories with required environment variables
5. Enable Red Hat OpenShift internal image registry following the instructions in this [link](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html/registry/setting-up-and-configuring-the-registry)

## Deployment Instructions

1. **Copy required files**

   Run the commands below to copy required files into specific directory. First make sure you are in directory `deployment/openshift/apps/openshift` relate to the project root.

   ```bash
   # Get env file from mcp context forge repo
   wget -O ./mcpgateway/.env https://raw.githubusercontent.com/IBM/mcp-context-forge/refs/heads/main/.env.example

   # Get env file from ibmi mcp server repo
   wget -O ./ibmi-mcp-server/.env https://raw.githubusercontent.com/IBM/ibmi-mcp-server/refs/heads/main/.env.example

   # Copy tools and secrets directories into deployment directory
   cp -r ../../../../{tools,secrets} ibmi-mcp-server/
   ```

2. **Configure DNS rebinding protection in `./ibmi-mcp-server/.env`**

   The server validates the `Host` header on every request and refuses to start when it is bound to a non-loopback address with IBM i credentials configured and authentication not enforced. The downloaded `.env.example` defaults to a loopback bind, which does not work in a pod. Set:

   ```bash
   # Required in a container — the pod must bind all interfaces
   MCP_HTTP_HOST=0.0.0.0

   # Allowlist the Route hostname clients use (see ibmi-mcp-server-route.yaml);
   # requests arriving under any other Host are rejected with 403
   MCP_ALLOWED_HOSTS=ibmi-mcp-server.apps.example.com

   # Authentication must be enforced, or the server refuses to start.
   # MCP_RESOURCE_URL is the Route URL of /mcp.
   # With OAUTH_ISSUER_URL the server verifies access tokens from your
   # authorization server and all SQL runs as the DB2i_USER service account.
   # This is what the manifests fit as shipped.
   MCP_AUTH_MODE=oauth
   MCP_RESOURCE_URL=https://ibmi-mcp-server.apps.example.com/mcp
   OAUTH_ISSUER_URL=https://auth.example.com
   # Without OAUTH_ISSUER_URL users sign on with their IBM i user profile and
   # SQL runs as that user. That needs changes to the manifests: see
   # "Built-in IBM i sign-on" below.

   # The router is a reverse proxy: list where its connections come from, so
   # that the server uses the client address the router reports.
   # MCP_TRUSTED_PROXIES=10.128.0.0/14

   # Deprecated alternative: IBM i token authentication
   # MCP_AUTH_MODE=ibmi
   # IBMI_HTTP_AUTH_ENABLED=true
   # MCP_TRUSTED_PROXIES=...   # required for /api/v1/auth behind the Route's TLS termination
   # ...or accept the risk explicitly on a trusted cluster network:
   # MCP_ALLOW_UNAUTHENTICATED_HTTP=true
   ```

   `MCP_TRUSTED_PROXIES` takes IP addresses or CIDR ranges. `oc get pods -n openshift-ingress -o wide` lists the router pods; when the router runs on the host network the source address is a node address instead. Without the setting the server ignores `X-Forwarded-For` and `X-Forwarded-Proto`, so all clients share the router's address for rate limiting.

   The liveness and readiness probes in `ibmi-mcp-server-deployment.yaml` already override their `Host` header to `localhost`, since kubelet otherwise sends the (dynamic) pod IP and the probes would 403.

   The tools ConfigMap is mounted at `/app/tools` and the key Secret at `/app/secrets` (the image's working directory is `/app`). Set `TOOLS_YAML_PATH=/app/tools` to load the mounted tools; the `.env.example` defaults `IBMI_AUTH_PRIVATE_KEY_PATH=secrets/private.pem` and `IBMI_AUTH_PUBLIC_KEY_PATH=secrets/public.pem` already resolve to the mounted keys. The keys are used only by the deprecated IBM i token authentication, but the kustomization still expects the two files in `ibmi-mcp-server/secrets/`.

3. **Set your namespace**

   Replace `<NAMESPACE_PLACEHOLDER>` in the root `kustomization.yaml` with your actual OpenShift namespace.

   Switch to your OpenShift namespace by running command:

   ```bash
   oc project <your_namespace>
   ```

4. **Deploy using Kustomize**:

   ```bash
   kustomize build . | oc apply -f -
   ```

5. **Monitor the image build**:

   ```bash
   oc logs -f bc/mcp-context-forge
   oc logs -f bc/ibmi-mcp-server
   ```

6. **Check deployment status**:

   ```bash
   oc get pods
   ```

7. **Get the URL for each application**

   ```bash
   echo "https://$(oc get route mcp-context-forge -o jsonpath='{.spec.host}')"
   echo "https://$(oc get route ibmi-mcp-server -o jsonpath='{.spec.host}')"
   ```

8. **Trigger the build manually**:

   ```bash
   # Trigger a new build using the source from remote repo
   oc start-build mcp-context-forge
   oc start-build ibmi-mcp-server
   # Trigger a new build using the source from local
   oc start-build mcp-context-forge --from-dir=.
   oc start-build ibmi-mcp-server --from-dir=.
   ```

## Built-in IBM i sign-on

With `MCP_AUTH_MODE=oauth` and no `OAUTH_ISSUER_URL`, users type their IBM i password into a page the server serves, so the server does not accept plain HTTP on a pod interface. The shipped Route terminates TLS at the router (`edge`) and forwards plain HTTP, which this mode refuses at startup. The router must re-encrypt and the pod must listen with TLS.

These steps were not run on a cluster for this release. Check each on yours.

1. **Service** (`ibmi-mcp-server/ibmi-mcp-server-service.yaml`): let the service CA issue a certificate.

   ```yaml
   metadata:
     name: ibmi-mcp-server
     annotations:
       service.beta.openshift.io/serving-cert-secret-name: ibmi-mcp-server-tls
   ```

2. **Deployment** (`ibmi-mcp-server/ibmi-mcp-server-deployment.yaml`): mount that Secret and probe over HTTPS.

   ```yaml
             readinessProbe:
               httpGet:
                 path: /healthz
                 port: 3010
                 scheme: HTTPS
             # ...the same for livenessProbe
             volumeMounts:
               - name: tls
                 mountPath: /app/tls
                 readOnly: true
         volumes:
           - name: tls
             secret:
               secretName: ibmi-mcp-server-tls
               defaultMode: 0400
   ```

3. **Route** (`ibmi-mcp-server/ibmi-mcp-server-route.yaml`): `termination: reencrypt`. With no `destinationCACertificate` the router verifies the pod against the service CA. Do not use `passthrough`: the router then adds no `X-Forwarded-For` and every user appears at the router's address.

4. **Mapepire certificate**: copy the certificate the server pins (or the CA that issued it) to `ibmi-mcp-server/secrets/mapepire.crt` and add `- secrets/mapepire.crt` to the `ibmi-mcp-secrets` generator in `ibmi-mcp-server/kustomization.yaml`. It is mounted at `/app/secrets/mapepire.crt`.

5. **`ibmi-mcp-server/.env`**:

   ```bash
   MCP_HTTP_HOST=0.0.0.0
   MCP_ALLOWED_HOSTS=ibmi-mcp-server.apps.example.com
   MCP_TLS_CERT_FILE=/app/tls/tls.crt
   MCP_TLS_KEY_FILE=/app/tls/tls.key
   MCP_TRUSTED_PROXIES=10.128.0.0/14   # where the router's connections come from

   MCP_AUTH_MODE=oauth
   MCP_RESOURCE_URL=https://ibmi-mcp-server.apps.example.com/mcp
   OAUTH_ADMIN_SOCKET=/tmp/ibmi-mcp-admin.sock

   DB2i_HOST=ibmi.example.com
   DB2i_SERVER_CERT_FILE=/app/secrets/mapepire.crt
   ```

   Remove `OAUTH_ISSUER_URL`, `DB2i_USER`, `DB2i_PASS` and `DB2i_IGNORE_UNAUTHORIZED`. `DB2i_PASS` stops startup in this mode, and so does `DB2i_IGNORE_UNAUTHORIZED=true` together with `DB2i_SERVER_CERT_FILE`; without a certificate file it turns verification of the Mapepire certificate off. `MCP_TRUSTED_PROXIES` is required here: the router sends `X-Forwarded-For`, and the sign-in page refuses such a request from an address that is not listed.

Notes:

- Sign-ons live in the memory of the one pod. A rollout or a pod restart signs every user out. Keep `replicas: 1`.
- Admin commands run inside the pod: `oc exec deploy/ibmi-mcp-server -- node packages/server/dist/index.js --admin "status"` (also `unblock <profile>` and `revoke <profile|grantId>`).
- Other pods that call the server directly, such as the MCP Context Forge gateway, must then use `https://ibmi-mcp-server.<namespace>.svc:3010` (add the name to `MCP_ALLOWED_HOSTS`) and trust the service CA. A gateway cannot sign on as a person; give it a separate instance with `OAUTH_ISSUER_URL`.

The full guide, including the IBM i setup this mode requires, is [docs/server-config/oauth.mdx](../../../../docs/server-config/oauth.mdx); the OpenShift specifics are in [docs/deployment/openshift.mdx](../../../../docs/deployment/openshift.mdx).

## Troubleshooting

- **Build failures**: Check build logs with `oc logs -f bc/mcp-context-forge`
- **Pod crashes**: Check pod logs with `oc logs <pod-name>`
- **Storage issues**: Verify PVC is bound with `oc get pvc`
- **Access issues**: Verify route with `oc get route mcp-context-forge`

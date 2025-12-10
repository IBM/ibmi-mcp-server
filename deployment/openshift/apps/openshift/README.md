# OpenShift Deployment

This directory contains Kubernetes/OpenShift manifests for deploying IBM i MCP Server and MCP Context Forge applications using Kustomize.

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
   # Copy dockerfile into server directory
   wget -O ../../../../server/Dockerfile https://raw.githubusercontent.com/IBM/ibmi-mcp-server/refs/heads/main/Dockerfile

   # Get env file from mcp context forge repo
   wget -O ./mcpgateway/.env https://raw.githubusercontent.com/IBM/mcp-context-forge/refs/heads/main/.env.example

   # Get env file from ibmi mcp server repo
   wget -O ./ibmi-mcp-server/.env https://raw.githubusercontent.com/IBM/ibmi-mcp-server/refs/heads/main/.env.example

   # Copy tools and secrets directories into deployment directory
   cp -r ../../../../{tools,secrets} ibmi-mcp-server/
   ```

2. **Set your namespace**

   Replace `<NAMESPACE_PLACEHOLDER>` in the root `kustomization.yaml` with your actual OpenShift namespace.

   Switch to your OpenShift namespace by running command:

   ```bash
   oc project <your_namespace>
   ```

3. **Deploy using Kustomize**:

   ```bash
   kustomize build . | oc apply -f -
   ```

4. **Monitor the image build**:

   ```bash
   oc logs -f bc/mcp-context-forge
   oc logs -f bc/ibmi-mcp-server
   ```

5. **Check deployment status**:

   ```bash
   oc get pods
   ```

6. **Get the URL for each application**

   ```bash
   echo "https://$(oc get route mcp-context-forge -o jsonpath='{.spec.host}')"
   echo "https://$(oc get route ibmi-mcp-server -o jsonpath='{.spec.host}')"
   ```

6. **Trigger the build manually**:

   ```bash
   # Trigger a new build using the source from remote repo
   oc start-build mcp-context-forge
   oc start-build ibmi-mcp-server
   # Trigger a new build using the source from local
   oc start-build mcp-context-forge --from-dir=.
   oc start-build ibmi-mcp-server --from-dir=.
   ```

## Troubleshooting

- **Build failures**: Check build logs with `oc logs -f bc/mcp-context-forge`
- **Pod crashes**: Check pod logs with `oc logs <pod-name>`
- **Storage issues**: Verify PVC is bound with `oc get pvc`
- **Access issues**: Verify route with `oc get route mcp-context-forge`

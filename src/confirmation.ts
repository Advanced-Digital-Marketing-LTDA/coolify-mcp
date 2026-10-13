import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export async function requestExactConfirmation(
  extra: ToolExtra,
  action: "deploy" | "restart",
  resourceName: string,
  resourceUuid: string,
): Promise<boolean> {
  const expected = `${action.toUpperCase()} ${resourceName} (${resourceUuid})`;
  const result = await extra.sendRequest(
    {
      method: "elicitation/create",
      params: {
        mode: "form",
        message: `Confirm ${action} for ${resourceName} (${resourceUuid}). Type exactly: ${expected}`,
        requestedSchema: {
          type: "object",
          properties: {
            confirmation: { type: "string", title: "Type the exact action and resource" },
          },
          required: ["confirmation"],
        },
      },
    },
    ElicitResultSchema,
    { signal: extra.signal, timeout: 120_000 },
  );
  return result.action === "accept" && result.content?.confirmation === expected;
}

import type { infer as Infer } from 'zod';
import {
  mcpDraftConnectSchema,
  mcpDraftCreateSchema,
  mcpDraftSaveUncheckedSchema,
  mcpDraftUpdateSchema,
  mcpDraftValidateSchema,
  mcpGatewayStatusSchema,
  mcpImportPreviewPayload,
  mcpImportCommitPayload,
  mcpImportPreviewResultPayload,
  mcpRegistryDraftSchema,
  mcpRegistrySnapshotSchema,
  mcpRegistryValidateResultPayload,
  mcpRegistryOAuthStartRequestSchema,
  mcpRegistryOAuthStartResponseSchema,
  mcpRegistryOAuthRevokeRequestSchema,
  mcpRegistryOAuthRevokeResponseSchema,
  mcpRegistryOAuthStatusSchema,
  mcpRegistryOAuthValidateRequestSchema,
  mcpRegistryOAuthValidateResponseSchema,
  mcpRegistryOAuthConnectRequestSchema,
  mcpRegistryOAuthConnectResponseSchema,
  mcpRegistryAgentStatusSchema,
  mcpRegistryMachineToggleRequestSchema,
  mcpRegistryMachineToggleResponseSchema,
  mcpServerConfigSchema,
} from '@agent-hub/shared';

export type McpServerConfig = Infer<typeof mcpServerConfigSchema>;
export type McpRegistryDraft = Infer<typeof mcpRegistryDraftSchema>;
export type McpRegistryDraftState = McpRegistryDraft['state'];
export type McpRegistryValidation = NonNullable<McpRegistryDraft['validation']> &
  Pick<Infer<typeof mcpRegistryValidateResultPayload>, 'oauthRequired' | 'authorizationUrl'> &
  Partial<Pick<Infer<typeof mcpRegistryValidateResultPayload>, 'status'>>;
export type McpRegistryDraftView = Omit<McpRegistryDraft, 'validation'> & {
  validation?: McpRegistryValidation;
};
export type McpRegistrySnapshot = Infer<typeof mcpRegistrySnapshotSchema>;
export type McpGatewayStatus = Infer<typeof mcpGatewayStatusSchema>;
export type McpDraftCreateRequest = Infer<typeof mcpDraftCreateSchema>;
export type McpRegistryCreateRequest = McpDraftCreateRequest & { sessionId?: string };
export type McpDraftUpdateRequest = Infer<typeof mcpDraftUpdateSchema>;
export type McpDraftValidateRequest = Infer<typeof mcpDraftValidateSchema>;
export type McpDraftConnectRequest = Infer<typeof mcpDraftConnectSchema>;
export type McpDraftSaveUncheckedRequest = Infer<typeof mcpDraftSaveUncheckedSchema>;
export type McpImportPreviewRequest = Infer<typeof mcpImportPreviewPayload>;
export type McpImportPreviewResult = Infer<typeof mcpImportPreviewResultPayload>;
export type McpImportPreviewServer = McpImportPreviewResult['servers'][number];

export type McpImportPreviewResponse = Omit<McpImportPreviewResult, 'secretValues'> & {
  revision: number;
};
export type McpRegistryImportCommitRequest = Infer<typeof mcpImportCommitPayload>;

export interface McpRegistryResponse {
  revision: number;
  servers: McpServerConfig[];
  drafts: McpRegistryDraftView[];
}

export type McpRegistryAgentStatus = Infer<typeof mcpRegistryAgentStatusSchema>;

export interface McpRegistryStatus {
  revision: number;
  agents: McpRegistryAgentStatus[];
  gateways: McpGatewayStatus[];
  oauth: McpRegistryOAuthStatus[];
}

export type McpRegistryOAuthStatus = Infer<typeof mcpRegistryOAuthStatusSchema>;
export type McpRegistryOAuthStartRequest = Infer<typeof mcpRegistryOAuthStartRequestSchema>;
export type McpRegistryOAuthStartResponse = Infer<typeof mcpRegistryOAuthStartResponseSchema>;
export type McpRegistryOAuthRevokeRequest = Infer<typeof mcpRegistryOAuthRevokeRequestSchema>;
export type McpRegistryOAuthRevokeResponse = Infer<typeof mcpRegistryOAuthRevokeResponseSchema>;
export type McpRegistryOAuthValidateRequest = Infer<typeof mcpRegistryOAuthValidateRequestSchema>;
export type McpRegistryOAuthValidateResponse = Infer<typeof mcpRegistryOAuthValidateResponseSchema>;
export type McpRegistryOAuthConnectRequest = Infer<typeof mcpRegistryOAuthConnectRequestSchema>;
export type McpRegistryOAuthConnectResponse = Infer<typeof mcpRegistryOAuthConnectResponseSchema>;
export type McpRegistryMachineToggleRequest = Infer<typeof mcpRegistryMachineToggleRequestSchema>;
export type McpRegistryMachineToggleResponse = Infer<typeof mcpRegistryMachineToggleResponseSchema>;

export interface McpRegistryPersistedDraftResponse {
  serverId: string;
  state: 'connected' | 'saved-unchecked';
  server: McpServerConfig;
}

export type McpRegistryServerUpdate = Partial<Omit<McpServerConfig, 'id' | 'revision' | 'secrets'>> & {
  revision: number;
};

export interface McpProjectOverride {
  serverId: string;
  projectId: string;
  enabled: boolean | null;
  revision: number;
}

export interface McpProjectOverrideUpdate {
  revision: number;
  enabled: boolean;
}

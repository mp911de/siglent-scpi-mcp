import { NodeSDK } from '@opentelemetry/sdk-node';

process.env.OTEL_SERVICE_NAME ??= 'siglent-scpi-mcp';
process.env.OTEL_BSP_SCHEDULE_DELAY ??= '500';

new NodeSDK().start();

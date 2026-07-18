import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

export interface ConversationHistoryProps {
  envName: string;
}

/**
 * Per-user conversation history, persistent across sessions (spec Section
 * 4.4 / 5). Partition key is userId; sort key turnId is a sortable string
 * (ISO timestamp + uuid) so Query with ScanIndexForward=false returns the
 * most recent turns first without a GSI.
 *
 * Retention/TTL policy is still an open sub-decision (spec Section 7) — the
 * `expiresAt` TTL attribute defaults to 180 days in the application code
 * (lambda/common/conversation-store.ts); this table only needs to declare
 * the TTL attribute name, not the retention duration itself.
 */
export class ConversationHistory extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: ConversationHistoryProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "ConversationHistoryTable", {
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "turnId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.envName === "prod" },
      removalPolicy: props.envName === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
  }
}

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

export interface TenantMembershipProps {
  envName: string;
}

/**
 * Email → tenant membership registry (multi-user support).
 *
 * Partition key is the user's `email` (lowercased); each item maps a user to
 * exactly one tenant with a role and status. A GSI on `tenantId` enables
 * listing all members of a tenant (admin UI).
 *
 * Status machine: PENDING (invited, not yet accepted) → ACTIVE (accepted).
 * The first user of a tenant (the provisioning admin) is created ACTIVE with
 * role `admin` at tenant activation time.
 */
export class TenantMembership extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: TenantMembershipProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "TenantMembershipTable", {
      partitionKey: { name: "email", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.envName === "prd" },
      removalPolicy: props.envName === "prd" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.table.addGlobalSecondaryIndex({
      indexName: "tenantId-index",
      partitionKey: { name: "tenantId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "email", type: dynamodb.AttributeType.STRING },
    });
  }
}

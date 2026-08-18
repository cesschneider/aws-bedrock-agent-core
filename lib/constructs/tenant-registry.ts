import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

export interface TenantRegistryProps {
  envName: string;
}

/**
 * Domain → tenant registry (multi-tenant design §4.1, Phase B2).
 *
 * Partition key is the email `domain` (lowercased); each item maps a domain
 * to a canonical `tenantId` plus tenant metadata (name, status, admin email,
 * verification token). `pre-token-generation` resolves a user's email domain
 * against this table and fails closed on unknown/unactivated domains.
 *
 * Status machine: PENDING → ACTIVE (on admin email confirmation) → SUSPENDED.
 */
export class TenantRegistry extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: TenantRegistryProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "TenantRegistryTable", {
      partitionKey: { name: "domain", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.envName === "prd" },
      removalPolicy: props.envName === "prd" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
  }
}

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

export interface OrganizationProps {
  envName: string;
}

/**
 * Organization registry (name-based org creation).
 *
 * Partition key is the `tenantId` slug derived from the chosen name. Each
 * item maps a tenant to its display name, admin email, and creation time.
 * Replaces the domain→tenant registry: there is no domain action and no
 * email-verification token.
 */
export class Organization extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: OrganizationProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "OrganizationTable", {
      partitionKey: { name: "tenantId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.envName === "prd" },
      removalPolicy: props.envName === "prd" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
  }
}

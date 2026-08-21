import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

export interface DocumentRegistryProps {
  envName: string;
}

/**
 * Registry of every uploaded document (multi-tenant design §4.2 extension).
 *
 * One record per uploaded document, written at upload time and updated at
 * ingestion time. This is the source of truth for the document list/get/delete
 * API — it carries the permission scope (tenant + department), size, tags,
 * timestamps, and ingestion status that the S3 object alone cannot expose.
 *
 * Access pattern:
 *   - List   → Query by tenantId (filter by department in the handler)
 *   - Get    → GetItem by (tenantId, documentId)
 *   - Delete → DeleteItem by (tenantId, documentId)
 *
 * Partition key is tenantId so a query can never cross tenant boundaries;
 * sort key is the documentId (the UUID embedded in the S3 object key).
 */
export class DocumentRegistry extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DocumentRegistryProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "DocumentRegistryTable", {
      partitionKey: { name: "tenantId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "documentId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.envName === "prd" },
      removalPolicy: props.envName === "prd" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
  }
}

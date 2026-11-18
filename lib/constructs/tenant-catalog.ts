import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

export interface TenantCatalogProps {
  envName: string;
}

/**
 * Per-tenant catalog of administrable departments and normalized tags.
 *
 * This is the source of truth for the admin UI's dropdowns: the list of
 * departments a tenant administers, and the normalized tag vocabulary that
 * uploads must draw from (so tags are not inserted ad hoc and stay
 * classifiable for search).
 *
 * Access pattern:
 *   - List departments/tags → Query by tenantId with begins_with(itemKey, kind)
 *   - Create/delete          → PutItem / DeleteItem by (tenantId, itemKey)
 *
 * Partition key is tenantId so a query can never cross tenant boundaries;
 * sort key is `{kind}#{name}` (e.g. `department#dept-engineering`,
 * `tag#finance`).
 */
export class TenantCatalog extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: TenantCatalogProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "TenantCatalogTable", {
      partitionKey: { name: "tenantId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "itemKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.envName === "prd" },
      removalPolicy: props.envName === "prd" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
  }
}

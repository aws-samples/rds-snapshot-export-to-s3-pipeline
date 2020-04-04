import * as cdk from "@aws-cdk/core";
import * as path from "path";
import {CfnCrawler} from "@aws-cdk/aws-glue";
import {ManagedPolicy, PolicyDocument, Role, ServicePrincipal, AccountRootPrincipal} from "@aws-cdk/aws-iam";
import {Code, Function, Runtime} from "@aws-cdk/aws-lambda";
import {SnsEventSource} from "@aws-cdk/aws-lambda-event-sources";
import {Key} from "@aws-cdk/aws-kms";
import {CfnEventSubscription} from "@aws-cdk/aws-rds";
import {BlockPublicAccess, Bucket} from "@aws-cdk/aws-s3";
import {Topic} from "@aws-cdk/aws-sns";

export enum RdsEventId {
  /**
   * Event IDs for which the Lambda supports starting a snapshot export task.
   *
   * See: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_Events.html
   */
  // For automated snapshots of Aurora RDS clusters
  DB_AUTOMATED_AURORA_SNAPSHOT_CREATED = "RDS-EVENT-0169",

  // For automated snapshots of non-Aurora RDS clusters
  DB_AUTOMATED_SNAPSHOT_CREATED = "RDS-EVENT-0091"
}

export interface RdsSnapshotExportPipelineStackProps extends cdk.StackProps {
  /**
   * Name of the S3 bucket to which snapshot exports should be saved.
   *
   * NOTE: Bucket will be created if one does not already exist.
   */
  readonly s3BucketName: string;

  /**
   * Name of the database cluster whose snapshots the function supports exporting.
   */
  readonly dbName: string;

  /**
   * The RDS event ID for which the function should be triggered.
   */
  readonly rdsEventId: RdsEventId;
};

export class RdsSnapshotExportPipelineStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: RdsSnapshotExportPipelineStackProps) {
    super(scope, id, props);

    const bucket = new Bucket(this, "SnapshotExportBucket", {
      bucketName: props.s3BucketName,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    });

    const snapshotExportTaskRole = new Role(this, "SnapshotExportTaskRole", {
      assumedBy: new ServicePrincipal("export.rds.amazonaws.com"),
      description: "Role used by RDS to perform snapshot exports to S3",
      inlinePolicies: {
        "SnapshotExportTaskPolicy": PolicyDocument.fromJson({
          "Version": "2012-10-17",
          "Statement": [
            {
              "Action": [
                "s3:PutObject*",
                "s3:ListBucket",
                "s3:GetObject*",
                "s3:DeleteObject*",
                "s3:GetBucketLocation"
              ],
              "Resource": [
                `${bucket.bucketArn}`,
                `${bucket.bucketArn}/*`,
              ],
              "Effect": "Allow"
            }
          ],
        })
      }
    });

    const lambdaExecutionRole = new Role(this, "RdsSnapshotExporterLambdaExecutionRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: 'RdsSnapshotExportToS3 Lambda execution role for the "' + props.dbName + '" database.',
      inlinePolicies: {
        "SnapshotExporterLambdaPolicy": PolicyDocument.fromJson({
          "Version": "2012-10-17",
          "Statement": [
            {
              "Action": "rds:StartExportTask",
              "Resource": "*",
              "Effect": "Allow",
            },
            {
              "Action": "iam:PassRole",
              "Resource": [snapshotExportTaskRole.roleArn],
              "Effect": "Allow",
            }
          ]
        })
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    const snapshotExportGlueCrawlerRole = new Role(this, "SnapshotExportsGlueCrawlerRole", {
      assumedBy: new ServicePrincipal("glue.amazonaws.com"),
      description: "Role used by RDS to perform snapshot exports to S3",
      inlinePolicies: {
        "SnapshotExportsGlueCrawlerPolicy": PolicyDocument.fromJson({
          "Version": "2012-10-17",
          "Statement": [
            {
              "Effect": "Allow",
              "Action": [
                "s3:GetObject",
                "s3:PutObject"
              ],
              "Resource": `${bucket.bucketArn}/*`,
            }
          ],
        }),
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSGlueServiceRole"),
      ],
    });

    const snapshotExportEncryptionKey = new Key(this, "SnapshotExportEncryptionKey", {
      alias: props.dbName + "-snapshot-exports",
      policy: PolicyDocument.fromJson({
        "Version": "2012-10-17",
        "Statement": [
          {
            "Principal": {
              "AWS": [
                (new AccountRootPrincipal()).arn,
                lambdaExecutionRole.roleArn,
                snapshotExportGlueCrawlerRole.roleArn
              ]
            },
            "Action": [
              "kms:Encrypt",
              "kms:Decrypt",
              "kms:ReEncrypt*",
              "kms:GenerateDataKey*",
              "kms:DescribeKey"
            ],
            "Resource": "*",
            "Effect": "Allow",
          },
          {
            "Principal": lambdaExecutionRole.roleArn,
            "Action": [
              "kms:CreateGrant",
              "kms:ListGrants",
              "kms:RevokeGrant"
            ],
            "Resource": "*",
            "Condition": {
                "Bool": {"kms:GrantIsForAWSResource": true}
            },
            "Effect": "Allow",
          }
        ]
      })
    });

    const snapshotEventTopic = new Topic(this, "SnapshotEventTopic", {
      displayName: "rds-snapshot-creation"
    });

    new CfnEventSubscription(this, 'RdsSnapshotEventNotification', {
      snsTopicArn: snapshotEventTopic.topicArn,
      enabled: true,
      eventCategories: ['creation'],
      sourceType: 'db-snapshot',
    });

    new Function(this, "LambdaFunction", {
      functionName: props.dbName + "-rds-snapshot-exporter",
      runtime: Runtime.PYTHON_3_8,
      handler: "main.handler",
      code: Code.fromAsset(path.join(__dirname, "/../assets/exporter/")),
      environment: {
        RDS_EVENT_ID: props.rdsEventId,
        DB_NAME: props.dbName,
        LOG_LEVEL: "INFO",
        SNAPSHOT_BUCKET_NAME: bucket.bucketName,
        SNAPSHOT_TASK_ROLE: snapshotExportTaskRole.roleArn,
        SNAPSHOT_TASK_KEY: snapshotExportEncryptionKey.keyArn,
      },
      role: lambdaExecutionRole,
      timeout: cdk.Duration.seconds(30),
      events: [
        new SnsEventSource(snapshotEventTopic)
      ]
    });

    new CfnCrawler(this, "SnapshotExportCrawler", {
      name: props.dbName + "-rds-snapshot-crawler",
      role: snapshotExportGlueCrawlerRole.roleArn,
      targets: {
        s3Targets: [
          {path: bucket.bucketName},
        ]
      },
      databaseName: props.dbName.replace(/[^a-zA-Z0-9_]/g, "_"),
      schemaChangePolicy: {
        deleteBehavior: 'DELETE_FROM_DATABASE'
      }
    });
  }
}

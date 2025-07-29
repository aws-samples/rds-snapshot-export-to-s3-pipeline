import { aws_lambda_event_sources, Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from "path";
import { aws_s3, aws_glue, aws_iam, aws_lambda, aws_sns, aws_rds, aws_kms } from 'aws-cdk-lib';
import { Policy } from 'aws-cdk-lib/aws-iam';

export enum RdsEventId {
  /**
   * Event IDs for which the Lambda supports starting a snapshot export task.
   * 
   * Note that with AWS Backup service, the service triggers a Manual snapshot created event (instead of automated),
   * where a new snapshot is created, or a finished copy notification when a prior snapshot of the same DB has been taken recently. 
   *
   * See:
   *   https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_Events.Messages.html#USER_Events.Messages.cluster-snapshot
   *   https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_Events.Messages.html#USER_Events.Messages.snapshot
   *   https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html 
   */
  // For automated snapshots of Aurora RDS clusters
  DB_AUTOMATED_AURORA_SNAPSHOT_CREATED = "RDS-EVENT-0169",

  // For automated snapshots of non-Aurora RDS clusters
  DB_AUTOMATED_SNAPSHOT_CREATED = "RDS-EVENT-0091",

  // // For manual snapshots of Aurora RDS clusters
  DB_MANUAL_AURORA_SNAPSHOT_CREATED = "RDS-EVENT-0075",

  // For manual snapshots and backup service snapshots of non-Aurora RDS clusters
  DB_MANUAL_SNAPSHOT_CREATED = "RDS-EVENT-0042",

  // For backup service snapshots copying ()
  DB_BACKUP_SNAPSHOT_FINISHED_COPY = "RDS-EVENT-0197",
}

export enum RdsSnapshotType {
  /**
   * Snapshot Types supported by the Lambda. Each RdsEventId used should correlate with the corresponsing snapshot type.
   * For instance: Automated snapshot event ID should be configured to work with Automated snapshot type
   * 
   * See:
   *  https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html#AutomatedBackups.AWSBackup
   *  
   */
  // For automated snapshots (system snapshots)
  DB_AUTOMATED_SNAPSHOT = "AUTOMATED",

  // For Backup service snapshots 
  DB_BACKUP_SNAPSHOT = "BACKUP",

  // For Backup service snapshots 
  DB_MANUAL_SNAPSHOT = "MANUAL"
}

export interface RdsSnapshot {
  rdsEventId: RdsEventId;
  rdsSnapshotType: RdsSnapshotType;
}

export interface RdsSnapshotExportPipelineStackProps extends StackProps {
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
   * The RDS event ID and snapshot type for which the function should be triggered.
   */
  readonly rdsEvents: Array<RdsSnapshot>;
};

export class RdsSnapshotExportPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: RdsSnapshotExportPipelineStackProps) {
    super(scope, id, props);

    const bucket = new aws_s3.Bucket(this, "SnapshotExportBucket", {
      bucketName: props.s3BucketName,
      blockPublicAccess: aws_s3.BlockPublicAccess.BLOCK_ALL,
    });

    const snapshotExportTaskRole = new aws_iam.Role(this, "SnapshotExportTaskRole", {
      assumedBy: new aws_iam.ServicePrincipal("export.rds.amazonaws.com"),
      description: "Role used by RDS to perform snapshot exports to S3",
      inlinePolicies: {
        "SnapshotExportTaskPolicy": aws_iam.PolicyDocument.fromJson({
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

    const lambdaExecutionRole = new aws_iam.Role(this, "RdsSnapshotExporterLambdaExecutionRole", {
      assumedBy: new aws_iam.ServicePrincipal("lambda.amazonaws.com"),
      description: 'RdsSnapshotExportToS3 Lambda execution role for the "' + props.dbName + '" database.',
      inlinePolicies: {
        "SnapshotExporterLambdaPolicy": aws_iam.PolicyDocument.fromJson({
          "Version": "2012-10-17",
          "Statement": [
            {
              "Action": [
                "rds:StartExportTask",
                "rds:DescribeDBSnapshots"
              ],
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
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    const snapshotExportGlueCrawlerRole = new aws_iam.Role(this, "SnapshotExportsGlueCrawlerRole", {
      assumedBy: new aws_iam.ServicePrincipal("glue.amazonaws.com"),
      description: "Role used by RDS to perform snapshot exports to S3",
      inlinePolicies: {
        "SnapshotExportsGlueCrawlerPolicy": aws_iam.PolicyDocument.fromJson({
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
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSGlueServiceRole"),
      ],
    });

    const snapshotExportEncryptionKey = new aws_kms.Key(this, "SnapshotExportEncryptionKey", {
      alias: props.dbName + "-snapshot-exports",
      policy: aws_iam.PolicyDocument.fromJson({
        "Version": "2012-10-17",
        "Statement": [
          {
            "Principal": {
              "AWS": [
                (new aws_iam.AccountRootPrincipal()).arn
              ]
            },
            "Action": [
              "kms:*"
            ],
            "Resource": "*",
            "Effect": "Allow"
          },
          {
            "Principal": {
              "AWS": [
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
            "Effect": "Allow"
          },
          {
            "Principal": { "AWS": lambdaExecutionRole.roleArn },
            "Action": [
              "kms:CreateGrant",
              "kms:ListGrants",
              "kms:RevokeGrant"
            ],
            "Resource": "*",
            "Condition": {
              "Bool": { "kms:GrantIsForAWSResource": true }
            },
            "Effect": "Allow"
          }
        ]
      })
    });

    const snapshotEventTopic = new aws_sns.Topic(this, "SnapshotEventTopic", {
      displayName: "rds-snapshot-creation"
    });

    // Creates the appropriate RDS Event Subscription for RDS or Aurora clusters, to catch snapshot creation events 
    props.rdsEvents.find(rdsEvent => 
      rdsEvent.rdsEventId == RdsEventId.DB_AUTOMATED_AURORA_SNAPSHOT_CREATED) ? 
        new aws_rds.CfnEventSubscription(this, 'RdsSnapshotEventNotification', {
          snsTopicArn: snapshotEventTopic.topicArn,
          enabled: true,
          eventCategories: ['backup'],
          sourceType: 'db-cluster-snapshot',
        }) :
        new aws_rds.CfnEventSubscription(this, 'RdsSnapshotEventNotification', {
          snsTopicArn: snapshotEventTopic.topicArn,
          enabled: true,
          eventCategories: ['creation'],
          sourceType: 'db-snapshot',
        }
      );

    // With AWS Backup Service, if a prior recent snapshot exists (if created by the Automated snapshot) 
    // the serivce will simply copy the existing snapshot, and trigger another notification  
    props.rdsEvents.find(rdsEvent => 
      rdsEvent.rdsEventId == RdsEventId.DB_BACKUP_SNAPSHOT_FINISHED_COPY) ? 
        new aws_rds.CfnEventSubscription(this, 'RdsBackupCopyEventNotification', {
          snsTopicArn: snapshotEventTopic.topicArn,
          enabled: true,
          eventCategories: ['notification'],
          sourceType: 'db-snapshot',
        }
      ) : true;

    new aws_lambda.Function(this, "LambdaFunction", {
      functionName: props.dbName.substring(0, 42) + "-rds-snapshot-exporter",
      runtime: aws_lambda.Runtime.PYTHON_3_13,
      handler: "main.handler",
      code: aws_lambda.Code.fromAsset(path.join(__dirname, "/../assets/exporter/")),
      environment: {
        RDS_EVENT_IDS: new Array(props.rdsEvents.map(e => { return e.rdsEventId })).join(),
        RDS_SNAPSHOT_TYPES: new Array(props.rdsEvents.map(e => { return e.rdsSnapshotType })).join(),
        DB_NAME: props.dbName,
        LOG_LEVEL: "INFO",
        SNAPSHOT_BUCKET_NAME: bucket.bucketName,
        SNAPSHOT_TASK_ROLE: snapshotExportTaskRole.roleArn,
        SNAPSHOT_TASK_KEY: snapshotExportEncryptionKey.keyArn,
        DB_SNAPSHOT_TYPES: new Array(props.rdsEvents.map(e => { return (e.rdsEventId == RdsEventId.DB_AUTOMATED_AURORA_SNAPSHOT_CREATED) || e.rdsEventId == RdsEventId.DB_MANUAL_AURORA_SNAPSHOT_CREATED ? "cluster-snapshot" : "snapshot" })).join()
      },
      role: lambdaExecutionRole,
      timeout: Duration.seconds(30),
      events: [
        new aws_lambda_event_sources.SnsEventSource(snapshotEventTopic)
      ]
    });

    new aws_glue.CfnCrawler(this, "SnapshotExportCrawler", {
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

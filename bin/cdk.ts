#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RdsSnapshotExportPipelineStack, RdsEventId, RdsSnapshotType } from '../lib/rds-snapshot-export-pipeline-stack';

const app = new cdk.App();
new RdsSnapshotExportPipelineStack(app, 'RdsSnapshotExportToS3Pipeline', {
  dbName: '<your-db-name>',
  rdsEvents:
    [
      {
        rdsEventId: RdsEventId.DB_AUTOMATED_SNAPSHOT_CREATED,
        rdsSnapshotType: RdsSnapshotType.DB_AUTOMATED_SNAPSHOT
      },
      {
        rdsEventId: RdsEventId.DB_MANUAL_SNAPSHOT_CREATED,
        rdsSnapshotType: RdsSnapshotType.DB_MANUAL_SNAPSHOT
      },
      {
        rdsEventId: RdsEventId.DB_BACKUP_SNAPSHOT_FINISHED_COPY,
        rdsSnapshotType: RdsSnapshotType.DB_BACKUP_SNAPSHOT
      }
    ],
  s3BucketName: '<your-target-s3-bucket-name>',
});
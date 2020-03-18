#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { RdsSnapshotExportPipelineStack, RdsEventId } from '../lib/rds-snapshot-export-pipeline-stack';

const app = new cdk.App();
new RdsSnapshotExportPipelineStack(app, 'RdsSnapshotExportToS3Pipeline', {
  dbName: '<existing-rds-database-name>',
  rdsEventId: RdsEventId.DB_AUTOMATED_SNAPSHOT_CREATED,
  s3BucketName: '<desired-s3-bucket-name>',
});

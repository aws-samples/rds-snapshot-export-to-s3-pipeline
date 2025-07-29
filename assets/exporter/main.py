from enum import Enum
import json
import logging
import os
import re

import boto3

"""
Evaluates whether or not the triggering event notification is for a Automated, 
Manual or AWS Backup service snapshot of the desired DB_NAME, then initiates an 
RDS snapshot export to S3 task of that snapshot if so.

The function returns the response from the `start_export_task` API call if
it was successful. The function execution will fail if any errors are produced
when making the API call. Otherwise, if the triggering event does not correspond
to the RDS_EVENT_ID or DB_NAME we are expecting to see, the function will return
nothing.
"""

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", logging.INFO))

AWS_REGION = os.environ["AWS_REGION"]
RDS_EVENT_IDS = os.environ["RDS_EVENT_IDS"]
RDS_SNAPSHOT_TYPES = os.environ["RDS_SNAPSHOT_TYPES"]
DB_NAME = os.environ["DB_NAME"]
SNAPSHOT_BUCKET_NAME = os.environ["SNAPSHOT_BUCKET_NAME"]
SNAPSHOT_TASK_ROLE = os.environ["SNAPSHOT_TASK_ROLE"]
SNAPSHOT_TASK_KEY = os.environ["SNAPSHOT_TASK_KEY"]
DB_SNAPSHOT_TYPES = os.environ["DB_SNAPSHOT_TYPES"]

# RDS_EVENT_IDS contains a string of Event IDs which should trigger the Lambda function
# RDS_SNAPSHOT_TYPES contains a string of snapshot types which should correspond with the Event IDs
rds_event_ids = RDS_EVENT_IDS.split(",")
rds_snapshot_types = RDS_SNAPSHOT_TYPES.split(",")
db_snapshot_types = DB_SNAPSHOT_TYPES.split(",")

SNAPSHOT_KEY_STRING = ":snapshot:"

class RdsSnapshotType(str, Enum):
    AUTOMATED = "AUTOMATED"
    BACKUP = "BACKUP"
    MANUAL = "MANUAL"

def handler(event, context):

    if len(rds_event_ids) != len(rds_snapshot_types):
        logger.error("Configuration error. Number of event IDs doesn't "
            "match number of snapshot types. Recheck the function environment variables")

        return

    if event["Records"][0]["EventSource"] != "aws:sns":
        logger.warning(
            "This function only supports invocations via SNS events, "
            "but was triggered by the following:\n"
            f"{json.dumps(event)}"
        )
        return

    logger.debug("EVENT INFO:")
    logger.debug(json.dumps(event))

    message = json.loads(event["Records"][0]["Sns"]["Message"])
    message_id = event["Records"][0]["Sns"]["MessageId"]

    handle_message(message, message_id)


def handle_message(message, message_id):

    event_counter = 0
    rds_event_re = "^rds:" + DB_NAME + "-\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}$"

    # Lambda function can be triggered by multiple events, from manual, automanted or backup service generated snapshots.
    # Each snapshot type and source requires a slightly different handling
    for i, rds_event_id in enumerate(rds_event_ids):

        # Identify and process an automated RDS snapshot
        if message["Event ID"].endswith(rds_event_id) and re.match(
            rds_event_re,
            message["Source ID"]
        ) and rds_snapshot_types[i] == RdsSnapshotType.AUTOMATED:
            process_automated_snapshot(message, message_id, db_snapshot_types[i])
            break
        # Identify and process an Manual RDS snapshot, which was not created by AWS Backup
        elif message["Event ID"].endswith(rds_event_id) and (
            not re.match(
                rds_event_re,
                message["Source ID"]
            ) and 
            not message["Source ID"].startswith("awsbackup:")
        ) and rds_snapshot_types[i] == RdsSnapshotType.MANUAL:
            process_manual_snapshot(message, message_id, db_snapshot_types[i])
            break
        # Identify and process an AWS Backup snapshot
        elif (message["Event ID"].endswith(rds_event_id) and 
            message["Source ID"].startswith("awsbackup:job-") and 
            rds_snapshot_types[i] == RdsSnapshotType.BACKUP
        ):
            process_backup_snapshot(message, message_id, db_snapshot_types[i])
            break
        else:
            event_counter += 1

    if (event_counter - 1) == i:    
        logger.info(f"Ignoring event notification for {message['Source ID']}")
        logger.info(
            f"Function is configured to accept {RDS_EVENT_IDS} "
            f"notifications for {DB_NAME} only"
        )


def process_automated_snapshot(message, message_id, db_snapshot_type):
    export_task_identifier = message_id
    account_id = boto3.client("sts").get_caller_identity()["Account"]

    export_task_identifier = (message["Source ID"][4:27] + '-').replace("--", "-") + message_id
    source_arn = f"arn:aws:rds:{AWS_REGION}:{account_id}:{db_snapshot_type}:{message['Source ID']}"

    start_export_task(export_task_identifier, source_arn) 


def process_manual_snapshot(message, message_id, db_snapshot_type):
    account_id = boto3.client("sts").get_caller_identity()["Account"]

    export_task_identifier = (message["Source ID"][:24] + '-').replace("--", "-") + message_id
    source_arn = f"arn:aws:rds:{AWS_REGION}:{account_id}:{db_snapshot_type}:{message['Source ID']}"

    start_export_task(export_task_identifier, source_arn) 


"""
An AWS Backup service snapshot notification does not contain the DB name, 
therefore an additional step is required to retrieve the snapshot details
and extract the DB Identifier to compare it against the expected DB_NAME
"""
def process_backup_snapshot(message, message_id, db_snapshot_type):
    source_arn = message['Source ARN']
    snapshot_id = source_arn[source_arn.rfind(SNAPSHOT_KEY_STRING) + len(SNAPSHOT_KEY_STRING):256]
    response = boto3.client("rds").describe_db_snapshots(DBSnapshotIdentifier=snapshot_id)

    logger.debug(response)

    if response and len(response["DBSnapshots"]) > 0:
        snapshot = response["DBSnapshots"][0]
     
        if ("SnapshotCreateTime" in snapshot):
            snapshot["SnapshotCreateTime"] = str(snapshot["SnapshotCreateTime"])
        if ("InstanceCreateTime" in snapshot):
            snapshot["InstanceCreateTime"] = str(snapshot["InstanceCreateTime"])
        if ("OriginalSnapshotCreateTime" in snapshot):
            snapshot["OriginalSnapshotCreateTime"] = str(snapshot["OriginalSnapshotCreateTime"])

        logger.debug(f"describing snapshot: {snapshot_id}, of source_arn {source_arn}")
        logger.debug(snapshot)

        if (snapshot and "DBInstanceIdentifier" in snapshot and snapshot["DBInstanceIdentifier"] == DB_NAME):
            export_task_identifier = (snapshot["DBInstanceIdentifier"] + '-').replace("--", "-") + snapshot["SnapshotCreateTime"][:10] + '-' + message_id
            start_export_task(export_task_identifier, source_arn)
        else:
            logger.info(f"Ignoring event notification for {message['Source ID']}")
            logger.info(
                f"Function is configured to accept "
                f"notifications for backup jobs of {DB_NAME} only."
            )
    else:
        logger.error(f"Could not describe snapshot of source {message['Source ID']}")
        raise Exception(f"Could not describe snapshot of source {message['Source ID']}, snapshot ID: {snapshot_id}")


def start_export_task(export_task_identifier, source_arn):
    logger.debug(f"exportTaskIdentifier: {export_task_identifier}")
    logger.debug(f"sourceARN: {source_arn}")

    response = boto3.client("rds").start_export_task(
        ExportTaskIdentifier=(
            export_task_identifier[:60]
        ),
        SourceArn=source_arn,
        S3BucketName=SNAPSHOT_BUCKET_NAME,
        IamRoleArn=SNAPSHOT_TASK_ROLE,
        KmsKeyId=SNAPSHOT_TASK_KEY,
    )

    response["SnapshotTime"] = str(response["SnapshotTime"])

    logger.info("Snapshot export task started")
    logger.info(json.dumps(response))

    return response


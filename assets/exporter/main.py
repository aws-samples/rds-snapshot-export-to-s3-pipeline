import json
import logging
import os
import re

import boto3

"""
Evaluates whether or not the triggering event notification is for an automated
snapshot of the desired DB_NAME, then initiates an RDS snapshot export to S3
task of that snapshot if so.

The function returns the response from the `start_export_task` API call if
it was successful. The function execution will fail if any errors are produced
when making the API call. Otherwise, if the triggering event does not correspond
to the RDS_EVENT_ID or DB_NAME we are expecting to see, the function will return
nothing.
"""

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", logging.INFO))


def handler(event, context):
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

    if message["Event ID"].endswith(os.environ["RDS_EVENT_ID"]) and re.match(
        "^rds:" + os.environ["DB_NAME"] + "-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$",
        message["Source ID"],
    ):
        export_task_identifier = event["Records"][0]["Sns"]["MessageId"]
        account_id = boto3.client("sts").get_caller_identity()["Account"]
        response = boto3.client("rds").start_export_task(
            ExportTaskIdentifier=(
                message["Source ID"][4:27] + '-' + event["Records"][0]["Sns"]["MessageId"]
            ),
            SourceArn=f"arn:aws:rds:{os.environ['AWS_REGION']}:{account_id}:snapshot:{message['Source ID']}",
            S3BucketName=os.environ["SNAPSHOT_BUCKET_NAME"],
            IamRoleArn=os.environ["SNAPSHOT_TASK_ROLE"],
            KmsKeyId=os.environ["SNAPSHOT_TASK_KEY"],
        )
        response["SnapshotTime"] = str(response["SnapshotTime"])

        logger.info("Snapshot export task started")
        logger.info(json.dumps(response))
    else:
        logger.info(f"Ignoring event notification for {message['Source ID']}")
        logger.info(
            f"Function is configured to accept {os.environ['RDS_EVENT_ID']} "
            f"notifications for {os.environ['DB_NAME']} only"
        )

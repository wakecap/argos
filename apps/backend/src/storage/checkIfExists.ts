import { get } from "./get";
import type { GetParams } from "./get";

/**
 * Check if an object exists in S3.
 */
export async function checkIfExists({ s3, ...other }: GetParams) {
  try {
    await get({ s3, ...other });
    return true;
  } catch (error) {
    // A missing key is a 404 (`NoSuchKey`) when the caller may list the
    // bucket, and a 403 (`AccessDenied`) when it may not.
    if (
      error instanceof Error &&
      "Code" in error &&
      (error.Code === "AccessDenied" || error.Code === "NoSuchKey")
    ) {
      return false;
    }
    throw error;
  }
}

import { deleteFile, getPresignedUploadUrl } from "@repo/s3";
import { asyncHandler } from "../services/asyncHandler";
import { appResponse } from "../services/appResponse";
import { AppError } from "../services/appError";

export const getUploadUrl = asyncHandler(async (req, res) => {
  const { key, contentType } = req.body;
  const url = await getPresignedUploadUrl(key, contentType);
  appResponse({ res, message: "Presigned URL generated", data: { url } });
});

export const removeFile = asyncHandler(async (req, res) => {
  if (!req.params?.key) {
    throw new AppError("Please provide key");
  }
  await deleteFile(req.params.key as string);
  appResponse({ res, message: "File deleted" });
});

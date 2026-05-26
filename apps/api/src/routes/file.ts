import { Router } from "express";
import { login, signup } from "../controller/auth.controller";
import { getUploadUrl, removeFile } from "../controller/upload";

const fileRouter = Router();

fileRouter.post("/get-presigned-url", getUploadUrl);
fileRouter.delete("/delete/:key", removeFile);

export { fileRouter };

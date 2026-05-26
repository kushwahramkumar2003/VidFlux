import { Router } from "express";
import { login, signup } from "../controller/auth.controller";
import { getUploadUrl, removeFile } from "../controller/upload";
import { transcodeVideo } from "../controller/video.controller";

const videoRouter = Router();

videoRouter.post("/create", transcodeVideo);

export { videoRouter };

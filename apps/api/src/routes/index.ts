import { Router } from "express";
import { authRouter } from "./auth";
import { fileRouter } from "./file";
import { authMiddleware } from "../middlewares/authMiddleware";
import { videoRouter } from "./video";

const router = Router();
router.use("/auth", authRouter);
router.use("/file", authMiddleware, fileRouter);
router.use("/video", authMiddleware, videoRouter);
export { router };

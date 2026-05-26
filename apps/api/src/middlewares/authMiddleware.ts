import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../utils/env";

declare global {
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

export const authMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const token = req.headers.cookie?.replace("token=", "");
  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const userId = jwt.verify(token, env.JWT_SECRET) as { id: string };
  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  req.userId = userId.id;
  next();
};

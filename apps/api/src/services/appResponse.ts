import type { Response } from "express";

interface AppResponseOptions<T> {
  res: Response;
  message: string;
  data?: T;
  statusCode?: number;
}

export const appResponse = <T>({
  res,
  message,
  data,
  statusCode = 200,
}: AppResponseOptions<T>): void => {
  res.status(statusCode).json({
    success: true,
    message,
    ...(data !== undefined && { data }),
  });
};

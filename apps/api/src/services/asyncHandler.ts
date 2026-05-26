import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "./appError";
import { Prisma } from "@repo/db";

type AsyncController = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void>;

const getP2002Fields = (err: Prisma.PrismaClientKnownRequestError): string => {
  const target = err.meta?.target as string[] | undefined;
  if (Array.isArray(target) && target.length > 0) {
    return target.join(", ");
  }

  const driverAdapterError = err.meta?.driverAdapterError as any;
  const fields = driverAdapterError?.cause?.constraint?.fields as
    | string[]
    | undefined;
  if (Array.isArray(fields) && fields.length > 0) {
    return fields.map((f: string) => f.replace(/"/g, "")).join(", ");
  }

  return "unknown field";
};

const handlePrismaError = (
  err: Prisma.PrismaClientKnownRequestError
): AppError => {
  switch (err.code) {
    case "P2002": {
      const field = getP2002Fields(err);
      return new AppError(`Duplicate value for field: ${field}`, 409);
    }
    case "P2025":
      return new AppError("Record not found", 404);

    case "P2003":
      return new AppError(
        "Related record not found (foreign key constraint)",
        404
      );

    case "P2014":
      return new AppError("Invalid relation", 400);

    default:
      return new AppError(`Database error: ${err.code}`, 500);
  }
};

const handleZodError = (err: ZodError): AppError => {
  const errors = err.issues.map((e) => ({
    field: e.path.join("."),
    message: e.message,
  }));

  const appErr = new AppError("Validation failed", 422);
  appErr.errors = errors;
  return appErr;
};

export const asyncHandler =
  (fn: AsyncController) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch((err) => {
      if (err instanceof ZodError) {
        return next(handleZodError(err));
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        return next(handlePrismaError(err));
      }

      if (err instanceof Prisma.PrismaClientValidationError) {
        return next(new AppError("Invalid data sent to database", 400));
      }

      next(err);
    });
  };

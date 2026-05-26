import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import type { AppError } from "./services/appError";
import { router } from "./routes";
const app = express();

app.use(
  cors({
    origin: "*",
  })
);

app.use(express.json());

app.use("/api/v1", router);
app.use((err: AppError, req: Request, res: Response, _next: NextFunction) => {
  res.status(err.statusCode ?? 500).json({
    message: err.message,
    ...(err.errors && { errors: err.errors }),
  });
});

app.listen(8080, () => {
  console.log("API server started on port 8080");
});

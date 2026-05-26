export class AppError extends Error {
  public errors?: { field: string; message: string }[];

  constructor(
    public override message: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = "AppError";
  }
}

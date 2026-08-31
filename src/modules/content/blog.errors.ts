import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  BLOG_POST_NOT_FOUND: "Blog post not found",
  BLOG_SLUG_TAKEN: "A blog post with this slug already exists",
  BLOG_MEDIA_NOT_FOUND: "Blog image not found",
  BLOG_MEDIA_FILE_REQUIRED: "An image file is required",
  BLOG_MEDIA_INVALID_TYPE: "Only JPEG, PNG, WebP or GIF images are allowed",
  BLOG_MEDIA_TOO_LARGE: "The image is too large",
  BLOG_MEDIA_REFERENCE_INVALID: "One or more referenced images do not exist",
};

export class BlogError extends AppError {
  public constructor(
    code: keyof typeof defaultMessages,
    statusCode = 400,
    details?: ErrorDetail[],
  ) {
    const message = defaultMessages[code] ?? code;
    super(message, statusCode, {
      details: details ?? [{ message, code }],
      expose: true,
    });
  }
}

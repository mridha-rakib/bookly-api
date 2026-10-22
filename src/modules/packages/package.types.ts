export const packageStatuses = ["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"] as const;
export type PackageStatus = (typeof packageStatuses)[number];
export const editablePackageStatuses = ["DRAFT", "ACTIVE", "INACTIVE"] as const;
export type EditablePackageStatus = (typeof editablePackageStatuses)[number];

export type PackageDependencyIssue = { itemId?: string; code: string };

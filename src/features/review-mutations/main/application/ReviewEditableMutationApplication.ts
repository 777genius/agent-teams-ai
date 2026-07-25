import type {
  DeleteEditedFileInput,
  SaveEditedFileInput,
} from '../../core/domain/reviewEditableMutationPolicy';
import type { ReviewEditableMutationDependencies } from './ReviewEditableMutationPorts';
import type { FileChangeWithContent } from '@shared/types/review';

interface AuthorizedRenameMutation {
  filePath: string;
  content: FileChangeWithContent;
}

export class ReviewEditableMutationApplication {
  constructor(private readonly dependencies: ReviewEditableMutationDependencies) {}

  async saveEditedFile(
    scopeValue: unknown,
    input: SaveEditedFileInput
  ): Promise<{ success: boolean }> {
    const filePath = await this.authorizeMutableFile(scopeValue, input.filePath);
    const result = await this.dependencies.applier.saveEditedFile(
      filePath,
      input.content,
      input.expectedCurrentContent
    );
    this.dependencies.content.invalidateFile(filePath);
    return result;
  }

  async deleteEditedFile(
    scopeValue: unknown,
    input: DeleteEditedFileInput
  ): Promise<{ success: boolean }> {
    const filePath = await this.authorizeMutableFile(scopeValue, input.filePath);
    const result = await this.dependencies.applier.deleteEditedFile(
      filePath,
      input.expectedCurrentContent
    );
    this.dependencies.content.invalidateFile(filePath);
    return result;
  }

  async restoreRejectedRename(
    scopeValue: unknown,
    filePathValue: unknown,
    expectationValue: unknown
  ): Promise<{ success: boolean }> {
    const authorized = await this.authorizeRenameMutation(
      scopeValue,
      filePathValue,
      expectationValue
    );
    try {
      return await this.dependencies.applier.restoreRejectedRename(
        authorized.filePath,
        authorized.content.originalFullContent,
        authorized.content.modifiedFullContent,
        authorized.content.snippets
      );
    } finally {
      this.dependencies.scope.invalidateAuthoritativeReviewContent(authorized.content);
    }
  }

  async reapplyRejectedRename(
    scopeValue: unknown,
    filePathValue: unknown,
    expectationValue: unknown
  ): Promise<{ success: boolean }> {
    const authorized = await this.authorizeRenameMutation(
      scopeValue,
      filePathValue,
      expectationValue
    );
    try {
      return await this.dependencies.applier.reapplyRejectedRename(
        authorized.filePath,
        authorized.content.originalFullContent,
        authorized.content.snippets
      );
    } finally {
      this.dependencies.scope.invalidateAuthoritativeReviewContent(authorized.content);
    }
  }

  private async authorizeMutableFile(scopeValue: unknown, filePathValue: unknown): Promise<string> {
    const { authorization } = await this.dependencies.scope.resolveReviewPathAuthorization(
      scopeValue,
      {
        requireIdentity: true,
      }
    );
    return this.dependencies.scope.validateAuthorizedReviewFilePath(authorization, filePathValue, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
  }

  private async authorizeRenameMutation(
    scopeValue: unknown,
    filePathValue: unknown,
    expectationValue: unknown
  ): Promise<AuthorizedRenameMutation> {
    const expectation =
      this.dependencies.scope.parseReviewRenameRecoveryExpectation(expectationValue);
    const { scope, authorization } = await this.dependencies.scope.resolveReviewPathAuthorization(
      scopeValue,
      {
        requireIdentity: true,
      }
    );
    const filePath = await this.dependencies.scope.validateAuthorizedReviewFilePath(
      authorization,
      filePathValue,
      {
        requireReviewedFile: true,
        rejectHardlinks: true,
      }
    );
    const content = await this.dependencies.scope.resolveAuthoritativeFileContent(
      scope,
      authorization,
      filePath
    );
    await this.dependencies.scope.validateSnippetPaths(authorization, content.snippets, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    this.dependencies.scope.assertExpectedAuthoritativeRename(content, expectation);
    return { filePath, content };
  }
}

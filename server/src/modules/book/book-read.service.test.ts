import { BookReadService } from './book-read.service';

function makeService() {
  const bookRepo = {
    findLibraryIdByBookId: vi.fn(),
    findFileById: vi.fn(),
    findAccessibleFiles: vi.fn(),
    findPrimaryFilesByBookIds: vi.fn(),
    findCards: vi.fn(),
    findCardsByBookIds: vi.fn(),
    countWhere: vi.fn(),
    findLibraryIdsByBookIds: vi.fn(),
    findRecommendationTitlesByBookIds: vi.fn(),
    findById: vi.fn(),
    updateMetadataFields: vi.fn(),
  };
  const scope = { visibleIdsOrAll: vi.fn().mockResolvedValue(null) };
  const service = new BookReadService(bookRepo as never, scope as never);
  return { service, bookRepo, scope };
}

describe('BookReadService', () => {
  it('passes credential-limited library ids to file queries', async () => {
    const { service, bookRepo, scope } = makeService();
    const user = { id: 7, active: true } as never;
    scope.visibleIdsOrAll.mockResolvedValue([5] as never);
    await service.findAccessibleFiles([9], user);
    expect(scope.visibleIdsOrAll).toHaveBeenCalledWith(user);
    expect(bookRepo.findAccessibleFiles).toHaveBeenCalledWith([9], user, [5]);
  });

  it('delegates read queries to BookRepository', () => {
    const { service, bookRepo } = makeService();
    bookRepo.findLibraryIdByBookId.mockReturnValue(3);
    bookRepo.findFileById.mockReturnValue({ id: 9 });
    bookRepo.findPrimaryFilesByBookIds.mockReturnValue([{ id: 1 }]);
    bookRepo.findCards.mockReturnValue([{ id: 7 }]);
    bookRepo.findCardsByBookIds.mockReturnValue([{ id: 8 }]);
    bookRepo.findLibraryIdsByBookIds.mockReturnValue([2, 4]);
    bookRepo.findRecommendationTitlesByBookIds.mockReturnValue(['Dune']);
    bookRepo.findById.mockReturnValue({ id: 22 });

    expect(service.findLibraryIdByBookId(11)).toBe(3);
    expect(bookRepo.findLibraryIdByBookId).toHaveBeenCalledWith(11);

    expect(service.findFileById(9)).toEqual({ id: 9 });
    expect(bookRepo.findFileById).toHaveBeenCalledWith(9);

    expect(service.findPrimaryFilesByBookIds([1, 2])).toEqual([{ id: 1 }]);
    expect(bookRepo.findPrimaryFilesByBookIds).toHaveBeenCalledWith([1, 2]);

    const where = {} as never;
    const orderBy = [{} as never];
    expect(service.findCards({ where, orderBy, limit: 20, offset: 0, userId: 4 })).toEqual([{ id: 7 }]);
    expect(bookRepo.findCards).toHaveBeenCalledWith({ where, orderBy, limit: 20, offset: 0, userId: 4 });

    expect(service.findCardsByBookIds([1, 2], 4)).toEqual([{ id: 8 }]);
    expect(bookRepo.findCardsByBookIds).toHaveBeenCalledWith([1, 2], 4);

    expect(service.findLibraryIdsByBookIds([10, 11])).toEqual([2, 4]);
    expect(bookRepo.findLibraryIdsByBookIds).toHaveBeenCalledWith([10, 11]);

    expect(service.findRecommendationTitlesByBookIds([10])).toEqual(['Dune']);
    expect(bookRepo.findRecommendationTitlesByBookIds).toHaveBeenCalledWith([10]);

    expect(service.findById(22)).toEqual({ id: 22 });
    expect(bookRepo.findById).toHaveBeenCalledWith(22);
  });

  it('delegates count and metadata updates', async () => {
    const { service, bookRepo } = makeService();
    const where = {} as never;
    const patch = { title: 'Updated' };

    bookRepo.countWhere.mockResolvedValue(12);
    bookRepo.updateMetadataFields.mockResolvedValue(undefined);

    await expect(service.countWhere(where)).resolves.toBe(12);
    expect(bookRepo.countWhere).toHaveBeenCalledWith(where);

    await expect(service.updateMetadataFields(3, patch)).resolves.toBeUndefined();
    expect(bookRepo.updateMetadataFields).toHaveBeenCalledWith(3, patch);
  });
});

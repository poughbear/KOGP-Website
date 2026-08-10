# Existing HEIC gallery photos

The upload page converts new HEIC and HEIF selections to JPEG in the visitor's browser before uploading them. Existing `.heic` and `.heif` objects are not changed automatically.

## Find existing HEIC or HEIF submissions

Run this read-only query in the Supabase SQL editor:

```sql
select id, storage_path, status, created_at
from public.gallery_uploads
where lower(storage_path) ~ '\.(heic|heif)$'
order by created_at desc;
```

## Replace an existing photo safely

For each photo that should remain in the gallery:

1. Download the original object from the private `gallery` bucket in Supabase Storage.
2. Open the deployed `/upload` page and submit that file again. The page will convert it to JPEG and create a new pending row.
3. Approve the new JPEG row and confirm that the photo appears on the gallery page.
4. Reject the old HEIC/HEIF row. Delete its storage object only if it is no longer needed as an archive.

Do not change an old row's `storage_path` to end in `.jpg` unless a real JPEG object has first been uploaded at that exact path. Renaming the database value alone does not convert the image.

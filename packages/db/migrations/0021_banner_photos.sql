-- 0021 Four more banner pictures: photo slots approved by the founder on 2026-11-23 (see docs/PHOTOS.md).
-- The list of picture names stays closed; this only widens it.

ALTER TABLE community_banners DROP CONSTRAINT community_banners_picture_check;
ALTER TABLE community_banners ADD CONSTRAINT community_banners_picture_check
  CHECK (picture IN ('none', 'family', 'community', 'celebrate', 'kids', 'explore', 'bannerCandles', 'bannerBirthday', 'bannerPicnic', 'bannerPark'));

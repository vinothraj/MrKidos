-- 0002 Seed the permission catalog (docs/SECURITY.md section 5) and system roles.
-- Roles beyond those used by the pilot MVP are seeded empty and reserved.

INSERT INTO permissions (code, description) VALUES
  ('platform.manage',            'Manage platform-wide settings and tenants'),
  ('audit.read',                 'Read audit log'),
  ('users.manage',               'Manage users'),
  ('roles.manage',               'Manage roles and assignments'),
  ('settings.manage',            'Manage platform settings'),
  ('view_as.use',                'Use audited view-as for support'),
  ('communities.create',         'Create communities'),
  ('communities.read',           'Read communities'),
  ('communities.update',         'Update communities'),
  ('communities.approve',        'Approve community activation'),
  ('memberships.approve',        'Approve resident memberships'),
  ('facilities.manage',          'Manage community facilities and venues'),
  ('policies.manage',            'Manage community policies'),
  ('families.read_own',          'Read own family'),
  ('families.manage_own',        'Manage own family'),
  ('children.manage_own',        'Manage own children profiles'),
  ('vendors.create',             'Create vendors'),
  ('vendors.read',               'Read vendors'),
  ('vendors.update',             'Update vendors'),
  ('vendors.vet',                'Review vendor vetting'),
  ('vendors.approve',            'Approve vendors'),
  ('vendors.suspend',            'Suspend vendors'),
  ('vendor_staff.manage',        'Manage vendor staff'),
  ('offerings.manage',           'Manage offerings'),
  ('availability.manage',        'Manage vendor availability'),
  ('vendor_documents.manage',    'Manage vendor documents'),
  ('categories.manage',          'Manage categories'),
  ('catalog.read',               'Browse catalog'),
  ('requests.create_own',        'Create own requests'),
  ('requests.read_own',          'Read own requests'),
  ('requests.read_community',    'Read community requests'),
  ('requests.read_all',          'Read all requests'),
  ('requests.comment_public',    'Add resident-visible comments'),
  ('requests.comment_internal',  'Add internal notes'),
  ('requests.transition',        'Transition request status'),
  ('requests.assign',            'Assign requests'),
  ('requests.cancel_own',        'Cancel own requests'),
  ('matching.run',               'Run vendor matching'),
  ('matching.override',          'Override matching results'),
  ('inquiries.send',             'Send vendor inquiries'),
  ('inquiries.respond',          'Respond to inquiries'),
  ('quotes.create',              'Create quotes'),
  ('quotes.compare',             'Compare quotes'),
  ('bookings.confirm',           'Confirm bookings'),
  ('bookings.complete',          'Complete bookings'),
  ('bookings.cancel',            'Cancel bookings'),
  ('community.approve_vendor',   'Approve vendors for the community'),
  ('community.approve_request',  'Approve requests for the community'),
  ('payments.record',            'Record offline payments'),
  ('payments.read',              'Read payment records'),
  ('reviews.create',             'Create reviews'),
  ('reviews.moderate',           'Moderate reviews'),
  ('reviews.reply',              'Reply to reviews'),
  ('notifications.read_own',     'Read own notifications'),
  ('notifications.templates.manage', 'Manage notification templates'),
  ('media.upload',               'Upload media'),
  ('media.read',                 'Read media');

INSERT INTO roles (tenant_id, scope_type, key, name, is_system) VALUES
  (NULL, 'platform',  'super_admin',          'Super Administrator',   true),
  (NULL, 'platform',  'platform_admin',       'Platform Administrator', true),
  (NULL, 'platform',  'business_operations',  'Business Operations',   true),
  (NULL, 'platform',  'vendor_manager',       'Vendor Manager',        true),
  (NULL, 'platform',  'customer_support',     'Customer Support',      true),
  (NULL, 'platform',  'finance',              'Finance',               true),
  (NULL, 'platform',  'marketing',            'Marketing',             true),
  (NULL, 'platform',  'analytics',            'Analytics',             true),
  (NULL, 'community', 'community_admin',      'Community Administrator', true),
  (NULL, 'community', 'community_manager',    'Community Manager',     true),
  (NULL, 'community', 'community_staff',      'Community Staff',       true),
  (NULL, 'community', 'resident',             'Resident',              true),
  (NULL, 'community', 'parent_guardian',      'Parent/Guardian',       true),
  (NULL, 'community', 'family_member',        'Family Member',         true),
  (NULL, 'vendor',    'vendor_owner',         'Vendor Owner',          true),
  (NULL, 'vendor',    'vendor_admin',         'Vendor Administrator',  true),
  (NULL, 'vendor',    'vendor_staff',         'Vendor Staff',          true),
  (NULL, 'vendor',    'vendor_service_provider', 'Vendor Service Provider', true),
  (NULL, 'platform',  'business_partner',     'Business Partner',      true),
  (NULL, 'platform',  'sponsor',              'Sponsor',               true),
  (NULL, 'platform',  'event_organizer',      'Event Organizer',       true);

-- Super administrator holds every permission.
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM roles r CROSS JOIN permissions p WHERE r.key = 'super_admin' AND r.tenant_id IS NULL;

-- Role to permission mapping for roles used by the pilot MVP.
WITH mapping (role_key, permission_code) AS (VALUES
  -- Business Operations
  ('business_operations', 'communities.create'), ('business_operations', 'communities.read'), ('business_operations', 'communities.update'),
  ('business_operations', 'memberships.approve'), ('business_operations', 'facilities.manage'), ('business_operations', 'policies.manage'),
  ('business_operations', 'vendors.create'), ('business_operations', 'vendors.read'), ('business_operations', 'vendors.update'),
  ('business_operations', 'vendors.vet'), ('business_operations', 'vendors.approve'), ('business_operations', 'vendors.suspend'),
  ('business_operations', 'vendor_staff.manage'), ('business_operations', 'offerings.manage'), ('business_operations', 'availability.manage'),
  ('business_operations', 'vendor_documents.manage'), ('business_operations', 'categories.manage'), ('business_operations', 'catalog.read'),
  ('business_operations', 'requests.read_all'), ('business_operations', 'requests.comment_public'), ('business_operations', 'requests.comment_internal'),
  ('business_operations', 'requests.transition'), ('business_operations', 'requests.assign'),
  ('business_operations', 'matching.run'), ('business_operations', 'matching.override'), ('business_operations', 'inquiries.send'),
  ('business_operations', 'quotes.create'), ('business_operations', 'quotes.compare'),
  ('business_operations', 'bookings.confirm'), ('business_operations', 'bookings.complete'), ('business_operations', 'bookings.cancel'),
  ('business_operations', 'payments.record'), ('business_operations', 'payments.read'),
  ('business_operations', 'reviews.moderate'), ('business_operations', 'notifications.read_own'), ('business_operations', 'media.upload'), ('business_operations', 'media.read'),
  -- Platform Administrator
  ('platform_admin', 'platform.manage'), ('platform_admin', 'audit.read'), ('platform_admin', 'users.manage'), ('platform_admin', 'roles.manage'),
  ('platform_admin', 'settings.manage'), ('platform_admin', 'communities.read'), ('platform_admin', 'communities.approve'),
  ('platform_admin', 'vendors.read'), ('platform_admin', 'catalog.read'), ('platform_admin', 'categories.manage'),
  -- Community Administrator
  ('community_admin', 'communities.read'), ('community_admin', 'communities.update'), ('community_admin', 'memberships.approve'),
  ('community_admin', 'facilities.manage'), ('community_admin', 'policies.manage'), ('community_admin', 'requests.read_community'),
  ('community_admin', 'community.approve_vendor'), ('community_admin', 'community.approve_request'),
  ('community_admin', 'catalog.read'), ('community_admin', 'notifications.read_own'),
  -- Resident and Parent/Guardian
  ('resident', 'catalog.read'), ('resident', 'requests.create_own'), ('resident', 'requests.read_own'), ('resident', 'requests.cancel_own'),
  ('resident', 'requests.comment_public'), ('resident', 'reviews.create'), ('resident', 'notifications.read_own'), ('resident', 'media.upload'),
  ('parent_guardian', 'families.read_own'), ('parent_guardian', 'families.manage_own'), ('parent_guardian', 'children.manage_own'),
  ('parent_guardian', 'catalog.read'), ('parent_guardian', 'requests.create_own'), ('parent_guardian', 'requests.read_own'),
  ('parent_guardian', 'requests.cancel_own'), ('parent_guardian', 'requests.comment_public'), ('parent_guardian', 'reviews.create'),
  ('parent_guardian', 'notifications.read_own'), ('parent_guardian', 'media.upload'),
  -- Vendor Owner / Administrator
  ('vendor_owner', 'vendors.read'), ('vendor_owner', 'vendors.update'), ('vendor_owner', 'vendor_staff.manage'), ('vendor_owner', 'offerings.manage'),
  ('vendor_owner', 'availability.manage'), ('vendor_owner', 'vendor_documents.manage'), ('vendor_owner', 'inquiries.respond'), ('vendor_owner', 'quotes.create'),
  ('vendor_owner', 'bookings.complete'), ('vendor_owner', 'reviews.reply'), ('vendor_owner', 'notifications.read_own'), ('vendor_owner', 'media.upload'), ('vendor_owner', 'media.read'),
  ('vendor_admin', 'vendors.read'), ('vendor_admin', 'vendors.update'), ('vendor_admin', 'offerings.manage'), ('vendor_admin', 'availability.manage'),
  ('vendor_admin', 'vendor_documents.manage'), ('vendor_admin', 'inquiries.respond'), ('vendor_admin', 'quotes.create'), ('vendor_admin', 'bookings.complete'),
  ('vendor_admin', 'reviews.reply'), ('vendor_admin', 'notifications.read_own'), ('vendor_admin', 'media.upload'), ('vendor_admin', 'media.read'),
  -- Vendor Staff
  ('vendor_staff', 'inquiries.respond'), ('vendor_staff', 'availability.manage'), ('vendor_staff', 'notifications.read_own'), ('vendor_staff', 'media.read')
)
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, m.permission_code
FROM mapping m
JOIN roles r ON r.key = m.role_key AND r.tenant_id IS NULL;

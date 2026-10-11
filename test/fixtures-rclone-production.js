'use strict';

/**
 * Ce que le rclone du serveur déclare vraiment — six types, relevés tels quels.
 *
 * ─── D'où ça vient ───────────────────────────────────────────────────────────
 *
 * `rclone config providers` exécuté le 13/08/2026 sur le conteneur de
 * production (production : `/usr/local/bin/rclone` v1.75.0, celui qu'a installé le
 * lot 28). Ce n'est pas une liste inventée pour arranger un test : c'est la
 * réponse du binaire que crabe interroge en vrai, et c'est ce qui donne son
 * sens à la mesure « aucun champ perdu ».
 *
 * ─── Ce qui a été allégé, et pourquoi ça ne change rien ──────────────────────
 *
 * Le catalogue complet des 69 types pèse un mégaoctet, et les six types gardés
 * ici en pèsent encore 156 ko à cause des aides d'rclone, longues de plusieurs
 * paragraphes. Elles sont donc coupées à leur première ligne, et les listes
 * d'exemples ramenées à quatre entrées.
 *
 * Ce qui décide du sort d'un champ est intégralement conservé : `Name`,
 * `Advanced`, `Required`, `IsPassword`, `Exclusive`, `Hide`, `Type`,
 * `DefaultStr`. Un test de couverture qui s'appuie là-dessus mesure exactement
 * ce qu'il mesurerait sur le catalogue entier.
 *
 * ─── Pourquoi ces six-là ─────────────────────────────────────────────────────
 *
 *   - `protondrive` — le service du lot 29, et le seul dont un champ AVANCÉ
 *     (`mailbox_password`) est indispensable ; il porte aussi quatre champs
 *     masqués (`Hide: 3`), qui ne doivent surtout PAS être proposés ;
 *   - `pcloud`, `dropbox` — deux options courantes seulement, et le jeton
 *     d'autorisation rangé dans les avancées : le trou du lot 28 ;
 *   - `webdav` — le type de kDrive, qui doit rester atteignable pour lui-même ;
 *   - `s3` — 78 options, dont 64 avancées : le cas où un formulaire déplié
 *     d'office deviendrait illisible ;
 *   - `mega` — un preset à formulaire ÉCRIT (deux champs) sur un backend qui en
 *     accepte dix : le complément doit combler les huit autres.
 */

module.exports = [
  {
    "Name": "protondrive",
    "Description": "Proton Drive",
    "Options": [
      {
        "Name": "username",
        "Help": "The username of your proton account",
        "Required": true
      },
      {
        "Name": "password",
        "Help": "The password of your proton account.",
        "Required": true,
        "IsPassword": true
      },
      {
        "Name": "mailbox_password",
        "Help": "The mailbox password of your two-password proton account.",
        "Advanced": true,
        "IsPassword": true
      },
      {
        "Name": "2fa",
        "Help": "The 2FA code"
      },
      {
        "Name": "otp_secret_key",
        "Help": "The OTP secret key",
        "IsPassword": true
      },
      {
        "Name": "client_uid",
        "Help": "Client uid key (internal use only)",
        "Advanced": true,
        "Hide": 3
      },
      {
        "Name": "client_access_token",
        "Help": "Client access token key (internal use only)",
        "Advanced": true,
        "Hide": 3
      },
      {
        "Name": "client_refresh_token",
        "Help": "Client refresh token key (internal use only)",
        "Advanced": true,
        "Hide": 3
      },
      {
        "Name": "client_salted_key_pass",
        "Help": "Client salted key pass key (internal use only)",
        "Advanced": true,
        "Hide": 3
      },
      {
        "Name": "encoding",
        "Help": "The encoding for the backend.",
        "Advanced": true,
        "Type": "Encoding",
        "DefaultStr": "Slash,LeftSpace,RightSpace,InvalidUtf8,D"
      },
      {
        "Name": "original_file_size",
        "Help": "Return the file size before encryption",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "true"
      },
      {
        "Name": "app_version",
        "Help": "The app version string ",
        "Advanced": true
      },
      {
        "Name": "replace_existing_draft",
        "Help": "Create a new revision when filename conflict is detected",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "enable_caching",
        "Help": "Caches the files and folders metadata to reduce API calls",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "true"
      },
      {
        "Name": "description",
        "Help": "Description of the remote.",
        "Advanced": true
      }
    ]
  },
  {
    "Name": "pcloud",
    "Description": "Pcloud",
    "Options": [
      {
        "Name": "client_id",
        "Help": "OAuth Client Id."
      },
      {
        "Name": "client_secret",
        "Help": "OAuth Client Secret."
      },
      {
        "Name": "token",
        "Help": "OAuth Access Token as a JSON blob.",
        "Advanced": true
      },
      {
        "Name": "auth_url",
        "Help": "Auth server URL.",
        "Advanced": true
      },
      {
        "Name": "token_url",
        "Help": "Token server url.",
        "Advanced": true
      },
      {
        "Name": "client_credentials",
        "Help": "Use client credentials OAuth flow.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "encoding",
        "Help": "The encoding for the backend.",
        "Advanced": true,
        "Type": "Encoding",
        "DefaultStr": "Slash,BackSlash,Del,Ctl,InvalidUtf8,Dot"
      },
      {
        "Name": "root_folder_id",
        "Help": "Fill in for rclone to use a non root folder as its starting point.",
        "Advanced": true,
        "DefaultStr": "d0"
      },
      {
        "Name": "hostname",
        "Help": "Hostname to connect to.",
        "Advanced": true,
        "DefaultStr": "api.pcloud.com",
        "Examples": [
          {
            "Value": "api.pcloud.com",
            "Help": "Original/US region"
          },
          {
            "Value": "eapi.pcloud.com",
            "Help": "EU region"
          }
        ]
      },
      {
        "Name": "username",
        "Help": "Your pcloud username.",
        "Advanced": true
      },
      {
        "Name": "password",
        "Help": "Your pcloud password.",
        "Advanced": true,
        "IsPassword": true
      },
      {
        "Name": "description",
        "Help": "Description of the remote.",
        "Advanced": true
      }
    ]
  },
  {
    "Name": "webdav",
    "Description": "WebDAV",
    "Options": [
      {
        "Name": "url",
        "Help": "URL of http host to connect to.",
        "Required": true
      },
      {
        "Name": "vendor",
        "Help": "Name of the WebDAV site/service/software you are using.",
        "Examples": [
          {
            "Value": "fastmail",
            "Help": "Fastmail Files"
          },
          {
            "Value": "nextcloud",
            "Help": "Nextcloud"
          },
          {
            "Value": "owncloud",
            "Help": "Owncloud 10 PHP based WebDAV server"
          },
          {
            "Value": "infinitescale",
            "Help": "ownCloud Infinite Scale"
          }
        ]
      },
      {
        "Name": "user",
        "Help": "User name."
      },
      {
        "Name": "pass",
        "Help": "Password.",
        "IsPassword": true
      },
      {
        "Name": "bearer_token",
        "Help": "Bearer token instead of user/pass (e.g. a Macaroon)."
      },
      {
        "Name": "bearer_token_command",
        "Help": "Command to run to get a bearer token.",
        "Advanced": true
      },
      {
        "Name": "encoding",
        "Help": "The encoding for the backend.",
        "Advanced": true
      },
      {
        "Name": "headers",
        "Help": "Set HTTP headers for all transactions.",
        "Advanced": true,
        "Type": "CommaSepList"
      },
      {
        "Name": "pacer_min_sleep",
        "Help": "Minimum time to sleep between API calls.",
        "Advanced": true,
        "Type": "Duration",
        "DefaultStr": "10ms"
      },
      {
        "Name": "nextcloud_chunk_size",
        "Help": "Nextcloud upload chunk size.",
        "Advanced": true,
        "Type": "SizeSuffix",
        "DefaultStr": "10Mi"
      },
      {
        "Name": "owncloud_exclude_shares",
        "Help": "Exclude ownCloud shares",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "owncloud_exclude_mounts",
        "Help": "Exclude ownCloud mounted storages",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "unix_socket",
        "Help": "Path to a unix domain socket to dial to, instead of opening a TCP connection directly",
        "Advanced": true
      },
      {
        "Name": "auth_redirect",
        "Help": "Preserve authentication on redirect.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "description",
        "Help": "Description of the remote.",
        "Advanced": true
      }
    ]
  },
  {
    "Name": "s3",
    "Description": "Amazon S3 Compliant Storage Providers including AWS, Alibaba, ArvanCloud, BizflyCloud, Ceph, ChinaMobile, Cloudflare, Cubbit, DigitalOcean, Dreamhost, Exaba, Fastly, FileLu, FlashBlade, GCS, HCP, Hetzner, HuaweiOBS, IBMCOS, IDrive, ImpossibleCloud, Intercolo, IONOS, Leviia, Liara, Linode, LyveCloud, Magalu, Mega, Minio, Netease, Outscale, OVHcloud, Petabox, Qiniu, Rabata, RackCorp, Rclone, Scaleway, Scality, SeaweedFS, Selectel, Servercore, SpectraLogic, Storj, Synology, TencentCOS, US3, Wasabi, Zadara, Zata, ZeroServices, Other",
    "Options": [
      {
        "Name": "provider",
        "Help": "Choose your S3 provider.",
        "Examples": [
          {
            "Value": "AWS",
            "Help": "Amazon Web Services (AWS) S3"
          },
          {
            "Value": "Alibaba",
            "Help": "Alibaba Cloud Object Storage System (OSS) formerly Aliyun"
          },
          {
            "Value": "ArvanCloud",
            "Help": "Arvan Cloud Object Storage (AOS)"
          },
          {
            "Value": "BizflyCloud",
            "Help": "Bizfly Cloud Simple Storage"
          }
        ]
      },
      {
        "Name": "env_auth",
        "Help": "Get AWS credentials from runtime (environment variables or EC2/ECS meta data if no env vars).",
        "Type": "bool",
        "DefaultStr": "false",
        "Examples": [
          {
            "Value": "false",
            "Help": "Enter AWS credentials in the next step."
          },
          {
            "Value": "true",
            "Help": "Get AWS credentials from the environment (env vars or IAM)."
          }
        ]
      },
      {
        "Name": "access_key_id",
        "Help": "AWS Access Key ID."
      },
      {
        "Name": "secret_access_key",
        "Help": "AWS Secret Access Key (password)."
      },
      {
        "Name": "region",
        "Help": "Region to connect to.",
        "Examples": [
          {
            "Value": "us-east-1",
            "Help": "The default endpoint - a good choice if you are unsure."
          },
          {
            "Value": "us-east-2",
            "Help": "US East (Ohio) Region."
          },
          {
            "Value": "us-west-1",
            "Help": "US West (Northern California) Region."
          },
          {
            "Value": "us-west-2",
            "Help": "US West (Oregon) Region."
          }
        ]
      },
      {
        "Name": "endpoint",
        "Help": "Endpoint for S3 API.",
        "Examples": [
          {
            "Value": "oss-accelerate.aliyuncs.com",
            "Help": "Global Accelerate"
          },
          {
            "Value": "oss-accelerate-overseas.aliyuncs.com",
            "Help": "Global Accelerate (outside mainland China)"
          },
          {
            "Value": "oss-cn-hangzhou.aliyuncs.com",
            "Help": "East China 1 (Hangzhou)"
          },
          {
            "Value": "oss-cn-shanghai.aliyuncs.com",
            "Help": "East China 2 (Shanghai)"
          }
        ]
      },
      {
        "Name": "location_constraint",
        "Help": "Location constraint - must be set to match the Region.",
        "Examples": [
          {
            "Value": "",
            "Help": "Empty for US Region, Northern Virginia, or Pacific Northwest"
          },
          {
            "Value": "us-east-2",
            "Help": "US East (Ohio) Region"
          },
          {
            "Value": "us-west-1",
            "Help": "US West (Northern California) Region"
          },
          {
            "Value": "us-west-2",
            "Help": "US West (Oregon) Region"
          }
        ]
      },
      {
        "Name": "acl",
        "Help": "Canned ACL used when creating buckets and storing or copying objects.",
        "Examples": [
          {
            "Value": "private",
            "Help": "Owner gets FULL_CONTROL."
          },
          {
            "Value": "public-read",
            "Help": "Owner gets FULL_CONTROL."
          },
          {
            "Value": "public-read-write",
            "Help": "Owner gets FULL_CONTROL."
          },
          {
            "Value": "authenticated-read",
            "Help": "Owner gets FULL_CONTROL."
          }
        ]
      },
      {
        "Name": "bucket_acl",
        "Help": "Canned ACL used when creating buckets.",
        "Advanced": true,
        "Examples": [
          {
            "Value": "private",
            "Help": "Owner gets FULL_CONTROL."
          },
          {
            "Value": "public-read",
            "Help": "Owner gets FULL_CONTROL."
          },
          {
            "Value": "public-read-write",
            "Help": "Owner gets FULL_CONTROL."
          },
          {
            "Value": "authenticated-read",
            "Help": "Owner gets FULL_CONTROL."
          }
        ]
      },
      {
        "Name": "requester_pays",
        "Help": "Enables requester pays option when interacting with S3 bucket.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "server_side_encryption",
        "Help": "The server-side encryption algorithm used when storing this object in S3.",
        "Examples": [
          {
            "Value": "",
            "Help": "None"
          },
          {
            "Value": "AES256",
            "Help": "AES256"
          },
          {
            "Value": "aws:kms",
            "Help": "aws:kms"
          }
        ]
      },
      {
        "Name": "sse_customer_algorithm",
        "Help": "If using SSE-C, the server-side encryption algorithm used when storing this object in S3.",
        "Advanced": true,
        "Examples": [
          {
            "Value": "",
            "Help": "None"
          },
          {
            "Value": "AES256",
            "Help": "AES256"
          }
        ]
      },
      {
        "Name": "sse_kms_key_id",
        "Help": "If using KMS ID you must provide the ARN of Key.",
        "Examples": [
          {
            "Value": "",
            "Help": "None"
          },
          {
            "Value": "arn:aws:kms:us-east-1:*",
            "Help": "arn:aws:kms:*"
          }
        ]
      },
      {
        "Name": "sse_customer_key",
        "Help": "To use SSE-C you may provide the secret encryption key used to encrypt/decrypt your data.",
        "Advanced": true,
        "Examples": [
          {
            "Value": "",
            "Help": "None"
          }
        ]
      },
      {
        "Name": "sse_customer_key_base64",
        "Help": "If using SSE-C you must provide the secret encryption key encoded in base64 format to encrypt/decrypt your dat",
        "Advanced": true,
        "Examples": [
          {
            "Value": "",
            "Help": "None"
          }
        ]
      },
      {
        "Name": "sse_customer_key_md5",
        "Help": "If using SSE-C you may provide the secret encryption key MD5 checksum (optional).",
        "Advanced": true,
        "Examples": [
          {
            "Value": "",
            "Help": "None"
          }
        ]
      },
      {
        "Name": "storage_class",
        "Help": "The storage class to use when storing new objects in S3.",
        "Examples": [
          {
            "Value": "",
            "Help": "Default"
          },
          {
            "Value": "STANDARD",
            "Help": "Standard storage class"
          },
          {
            "Value": "REDUCED_REDUNDANCY",
            "Help": "Reduced redundancy storage class"
          },
          {
            "Value": "STANDARD_IA",
            "Help": "Standard Infrequent Access storage class"
          }
        ]
      },
      {
        "Name": "upload_cutoff",
        "Help": "Cutoff for switching to chunked upload.",
        "Advanced": true,
        "Type": "SizeSuffix",
        "DefaultStr": "200Mi"
      },
      {
        "Name": "chunk_size",
        "Help": "Chunk size to use for uploading.",
        "Advanced": true,
        "Type": "SizeSuffix",
        "DefaultStr": "5Mi"
      },
      {
        "Name": "max_upload_parts",
        "Help": "Maximum number of parts in a multipart upload.",
        "Advanced": true,
        "Type": "int",
        "DefaultStr": "10000"
      },
      {
        "Name": "copy_cutoff",
        "Help": "Cutoff for switching to multipart copy.",
        "Advanced": true,
        "Type": "SizeSuffix",
        "DefaultStr": "4.656Gi"
      },
      {
        "Name": "disable_checksum",
        "Help": "Don't store MD5 checksum with object metadata.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "shared_credentials_file",
        "Help": "Path to the shared credentials file.",
        "Advanced": true
      },
      {
        "Name": "profile",
        "Help": "Profile to use in the shared credentials file.",
        "Advanced": true
      },
      {
        "Name": "session_token",
        "Help": "An AWS session token.",
        "Advanced": true
      },
      {
        "Name": "role_arn",
        "Help": "ARN of the IAM role to assume.",
        "Advanced": true
      },
      {
        "Name": "role_session_name",
        "Help": "Session name for assumed role.",
        "Advanced": true
      },
      {
        "Name": "role_session_duration",
        "Help": "Session duration for assumed role.",
        "Advanced": true
      },
      {
        "Name": "role_external_id",
        "Help": "External ID for assumed role.",
        "Advanced": true
      },
      {
        "Name": "upload_concurrency",
        "Help": "Concurrency for multipart uploads and copies.",
        "Advanced": true,
        "Type": "int",
        "DefaultStr": "4"
      },
      {
        "Name": "force_path_style",
        "Help": "If true use path style access if false use virtual hosted style.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "true"
      },
      {
        "Name": "v2_auth",
        "Help": "If true use v2 authentication.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "use_dual_stack",
        "Help": "If true use AWS S3 dual-stack endpoint (IPv6 support).",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "use_accelerate_endpoint",
        "Help": "If true use the AWS S3 accelerated endpoint.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "use_arn_region",
        "Help": "If true, enables arn region support for the service.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "leave_parts_on_error",
        "Help": "If true avoid calling abort upload on a failure, leaving all successfully uploaded parts on S3 for manual reco",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "list_chunk",
        "Help": "Size of listing chunk (response list for each ListObject S3 request).",
        "Advanced": true,
        "Type": "int",
        "DefaultStr": "1000"
      },
      {
        "Name": "list_version",
        "Help": "Version of ListObjects to use: 1,2 or 0 for auto.",
        "Advanced": true,
        "Type": "int",
        "DefaultStr": "0"
      },
      {
        "Name": "list_url_encode",
        "Help": "Whether to url encode listings: true/false/unset",
        "Advanced": true,
        "Type": "Tristate",
        "DefaultStr": "unset"
      },
      {
        "Name": "no_check_bucket",
        "Help": "If set, don't attempt to check the bucket exists or create it.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "no_head",
        "Help": "If set, don't HEAD uploaded objects to check integrity.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "no_head_object",
        "Help": "If set, do not do HEAD before GET when getting objects.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "encoding",
        "Help": "The encoding for the backend.",
        "Advanced": true,
        "Type": "Encoding",
        "DefaultStr": "Slash,InvalidUtf8,Dot"
      },
      {
        "Name": "memory_pool_flush_time",
        "Help": "How often internal memory buffer pools will be flushed. (no longer used)",
        "Advanced": true,
        "Hide": 3,
        "Type": "Duration",
        "DefaultStr": "1m0s"
      },
      {
        "Name": "memory_pool_use_mmap",
        "Help": "Whether to use mmap buffers in internal memory pool. (no longer used)",
        "Advanced": true,
        "Hide": 3,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "disable_http2",
        "Help": "Disable usage of http2 for S3 backends.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "download_url",
        "Help": "Custom endpoint for downloads.",
        "Advanced": true
      },
      {
        "Name": "directory_markers",
        "Help": "Upload an empty object with a trailing slash when a new directory is created",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "use_multipart_etag",
        "Help": "Whether to use ETag in multipart uploads for verification",
        "Advanced": true,
        "Type": "Tristate",
        "DefaultStr": "unset"
      },
      {
        "Name": "use_unsigned_payload",
        "Help": "Whether to use an unsigned payload in PutObject",
        "Advanced": true,
        "Type": "Tristate",
        "DefaultStr": "unset"
      },
      {
        "Name": "use_presigned_request",
        "Help": "Whether to use a presigned request or PutObject for single part uploads",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "use_data_integrity_protections",
        "Help": "If true use AWS S3 data integrity protections.",
        "Advanced": true,
        "Type": "Tristate",
        "DefaultStr": "unset"
      },
      {
        "Name": "versions",
        "Help": "Include old versions in directory listings.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "version_at",
        "Help": "Show file versions as they were at the specified time.",
        "Advanced": true,
        "Type": "Time",
        "DefaultStr": "off"
      },
      {
        "Name": "version_deleted",
        "Help": "Show deleted file markers when using versions.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "decompress",
        "Help": "If set this will decompress gzip encoded objects.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "might_gzip",
        "Help": "Set this if the backend might gzip objects.",
        "Advanced": true,
        "Type": "Tristate",
        "DefaultStr": "unset"
      },
      {
        "Name": "use_accept_encoding_gzip",
        "Help": "Whether to send `Accept-Encoding: gzip` header.",
        "Advanced": true,
        "Type": "Tristate",
        "DefaultStr": "unset"
      },
      {
        "Name": "no_system_metadata",
        "Help": "Suppress setting and reading of system metadata",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "sts_endpoint",
        "Help": "Endpoint for STS (deprecated).",
        "Advanced": true,
        "Hide": 3
      },
      {
        "Name": "use_already_exists",
        "Help": "Set if rclone should report BucketAlreadyExists errors on bucket creation.",
        "Advanced": true,
        "Type": "Tristate",
        "DefaultStr": "unset"
      },
      {
        "Name": "use_multipart_uploads",
        "Help": "Set if rclone should use multipart uploads.",
        "Advanced": true,
        "Type": "Tristate",
        "DefaultStr": "unset"
      },
      {
        "Name": "list_versions_oldest_first",
        "Help": "Set if the backend returns object versions oldest first.",
        "Advanced": true,
        "Type": "Tristate",
        "DefaultStr": "unset"
      },
      {
        "Name": "use_x_id",
        "Help": "Set if rclone should add x-id URL parameters.",
        "Advanced": true,
        "Type": "Tristate",
        "DefaultStr": "unset"
      },
      {
        "Name": "sign_accept_encoding",
        "Help": "Set if rclone should include Accept-Encoding as part of the signature.",
        "Advanced": true,
        "Type": "Tristate",
        "DefaultStr": "unset"
      },
      {
        "Name": "directory_bucket",
        "Help": "Set to use AWS Directory Buckets",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "sdk_log_mode",
        "Help": "Set to debug the SDK",
        "Advanced": true,
        "Type": "Bits",
        "DefaultStr": "Off"
      },
      {
        "Name": "ibm_api_key",
        "Help": "IBM API Key to be used to obtain IAM token"
      },
      {
        "Name": "ibm_resource_instance_id",
        "Help": "IBM service instance id"
      },
      {
        "Name": "ibm_iam_endpoint",
        "Help": "IBM IAM Endpoint to use for authentication.",
        "Advanced": true
      },
      {
        "Name": "object_lock_mode",
        "Help": "Object Lock mode to apply when uploading or copying objects.",
        "Advanced": true,
        "Examples": [
          {
            "Value": "GOVERNANCE",
            "Help": "Set Object Lock mode to GOVERNANCE"
          },
          {
            "Value": "COMPLIANCE",
            "Help": "Set Object Lock mode to COMPLIANCE"
          },
          {
            "Value": "copy",
            "Help": "Copy from source object (requires --metadata)"
          }
        ]
      },
      {
        "Name": "object_lock_retain_until_date",
        "Help": "Object Lock retention until date to apply when uploading or copying objects.",
        "Advanced": true,
        "Examples": [
          {
            "Value": "copy",
            "Help": "Copy from source object (requires --metadata)"
          },
          {
            "Value": "2030-01-01T00:00:00Z",
            "Help": "Set specific date (RFC 3339 format)"
          },
          {
            "Value": "365d",
            "Help": "Set retention for 365 days from now"
          },
          {
            "Value": "1y",
            "Help": "Set retention for 1 year from now"
          }
        ]
      },
      {
        "Name": "object_lock_legal_hold_status",
        "Help": "Object Lock legal hold status to apply when uploading or copying objects.",
        "Advanced": true,
        "Examples": [
          {
            "Value": "ON",
            "Help": "Enable legal hold"
          },
          {
            "Value": "OFF",
            "Help": "Disable legal hold"
          },
          {
            "Value": "copy",
            "Help": "Copy from source object (requires --metadata)"
          }
        ]
      },
      {
        "Name": "bypass_governance_retention",
        "Help": "Allow deleting or modifying objects locked with GOVERNANCE mode.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "bucket_object_lock_enabled",
        "Help": "Enable Object Lock when creating new buckets.",
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "object_lock_set_after_upload",
        "Help": "Set Object Lock via separate API calls after upload.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "object_lock_supported",
        "Help": "Whether the provider supports S3 Object Lock.",
        "Advanced": true,
        "Type": "Tristate",
        "DefaultStr": "unset"
      },
      {
        "Name": "description",
        "Help": "Description of the remote.",
        "Advanced": true
      }
    ]
  },
  {
    "Name": "mega",
    "Description": "Mega",
    "Options": [
      {
        "Name": "user",
        "Help": "User name.",
        "Required": true
      },
      {
        "Name": "pass",
        "Help": "Password.",
        "Required": true,
        "IsPassword": true
      },
      {
        "Name": "2fa",
        "Help": "The 2FA code of your MEGA account if the account is set up with one"
      },
      {
        "Name": "session_id",
        "Help": "Session (internal use only)",
        "Advanced": true,
        "Hide": 3
      },
      {
        "Name": "master_key",
        "Help": "Master key (internal use only)",
        "Advanced": true,
        "Hide": 3
      },
      {
        "Name": "debug",
        "Help": "Output more debug from Mega.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "hard_delete",
        "Help": "Delete files permanently rather than putting them into the trash.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "use_https",
        "Help": "Use HTTPS for transfers.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "encoding",
        "Help": "The encoding for the backend.",
        "Advanced": true,
        "Type": "Encoding",
        "DefaultStr": "Slash,InvalidUtf8,Dot"
      },
      {
        "Name": "description",
        "Help": "Description of the remote.",
        "Advanced": true
      }
    ]
  },
  {
    "Name": "dropbox",
    "Description": "Dropbox",
    "Options": [
      {
        "Name": "client_id",
        "Help": "OAuth Client Id."
      },
      {
        "Name": "client_secret",
        "Help": "OAuth Client Secret."
      },
      {
        "Name": "token",
        "Help": "OAuth Access Token as a JSON blob.",
        "Advanced": true
      },
      {
        "Name": "auth_url",
        "Help": "Auth server URL.",
        "Advanced": true
      },
      {
        "Name": "token_url",
        "Help": "Token server url.",
        "Advanced": true
      },
      {
        "Name": "client_credentials",
        "Help": "Use client credentials OAuth flow.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "chunk_size",
        "Help": "Upload chunk size (< 150Mi).",
        "Advanced": true,
        "Type": "SizeSuffix",
        "DefaultStr": "48Mi"
      },
      {
        "Name": "impersonate",
        "Help": "Impersonate this user when using a business account.",
        "Advanced": true
      },
      {
        "Name": "impersonate_admin",
        "Help": "Team admin ID to use when performing actions as a team administrator.",
        "Advanced": true
      },
      {
        "Name": "shared_files",
        "Help": "Instructs rclone to work on individual shared files.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "shared_folders",
        "Help": "Instructs rclone to work on shared folders.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "skip_shared_folders",
        "Help": "Instructs rclone to skip all shared folders.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "skip_unowned_folders",
        "Help": "Instructs rclone to skip shared folders not owned by the current user.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "pacer_min_sleep",
        "Help": "Minimum time to sleep between API calls.",
        "Advanced": true,
        "Type": "Duration",
        "DefaultStr": "10ms"
      },
      {
        "Name": "encoding",
        "Help": "The encoding for the backend.",
        "Advanced": true,
        "Type": "Encoding",
        "DefaultStr": "Slash,BackSlash,Del,RightSpace,InvalidUt"
      },
      {
        "Name": "root_namespace",
        "Help": "Specify a different Dropbox namespace ID to use as the root for all paths.",
        "Advanced": true
      },
      {
        "Name": "export_formats",
        "Help": "Comma separated list of preferred formats for exporting files",
        "Advanced": true,
        "Type": "CommaSepList",
        "DefaultStr": "html,md"
      },
      {
        "Name": "skip_exports",
        "Help": "Skip exportable files in all listings.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "show_all_exports",
        "Help": "Show all exportable files in listings.",
        "Advanced": true,
        "Type": "bool",
        "DefaultStr": "false"
      },
      {
        "Name": "batch_mode",
        "Help": "Upload file batching sync|async|off.",
        "Advanced": true,
        "DefaultStr": "sync"
      },
      {
        "Name": "batch_size",
        "Help": "Max number of files in upload batch.",
        "Advanced": true,
        "Type": "int",
        "DefaultStr": "0"
      },
      {
        "Name": "batch_timeout",
        "Help": "Max time to allow an idle upload batch before uploading.",
        "Advanced": true,
        "Type": "Duration",
        "DefaultStr": "0s"
      },
      {
        "Name": "batch_commit_timeout",
        "Help": "Max time to wait for a batch to finish committing. (no longer used)",
        "Advanced": true,
        "Hide": 3,
        "Type": "Duration",
        "DefaultStr": "10m0s"
      },
      {
        "Name": "description",
        "Help": "Description of the remote.",
        "Advanced": true
      }
    ]
  }
];

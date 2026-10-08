# List tags

Get all users tags.

```
GET /tags
```

Required [scope](https://developer.toshl.com/docs/auth#scope):

- tags:r

## Parameters

|                                                    |                                                                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **page**<br>_optional_<br>`integer`                | Page to display, used for [pagination](https://developer.toshl.com/docs#pagination).<br> _Minimum:_ `>= 0`<br>_Default value:_ `0`                                                               |
| **per_page**<br>_optional_<br>`integer`            | Number of resource objects to return.<br> _Minimum:_ `>= 10`<br>_Maximum:_ `=< 500`<br>_Default value:_ `50`                                                                                     |
| **since**<br>_optional_<br>`string`                | Return all tags that were modified since timestamp.<br> _Format:_ `date-time`                                                                                                                    |
| **type**<br>_optional_<br>`string`                 | Tag type<br> _Possible values:_ `expense, income`                                                                                                                                                |
| **ids**<br>_optional_<br>`string`                  | Comma separated list of tag ids.                                                                                                                                                                 |
| **categories**<br>_optional_<br>`string`           | Comma separated list of category ids. When set, only tags with selected categories are returned. If this is an empty list only tags that are not linked to a category are returned.             |
| **used_with_tags**<br>_optional_<br>`string`       | Comma separated list of tag ids. When set, only tags that were used with the selected tags are returned.                                                                                        |
| **used_with_tags_min**<br>_optional_<br>`integer`  | Parameter is used in combination with used_with_tags parameter. Number of times the tag should be used with used_with_tags to be considered used with.<br> _Minimum:_ `>= 1`<br>_Default value:_ `1` |
| **used_with_categories**<br>_optional_<br>`string` | Comma separated list of category ids. When set, only tags that were used with the selected categories are returned.                                                                             |
| **search**<br>_optional_<br>`string`               | Used to search tags.                                                                                                                                                                             |
| **include_deleted**<br>_optional_<br>`boolean`     | Include deleted tags.                                                                                                                                                                            |

**\*** denotes _required_ field/parameter.

## Request

```
$ curl https://api.toshl.com/tags \
  -H "Authorization: Bearer <API-KEY>"
```

## Response

```http
HTTP/1.1 200 OK
Content-Type: application/json

[
  {
    "id": "42",
    "name": "coffee",
    "modified": "2012-09-04T13:55:15Z",
    "type": "expense",
    "category": "43",
    "count": 5,
    "deleted": 0
  }
]
```

Page last modified: 08 Jan 2024

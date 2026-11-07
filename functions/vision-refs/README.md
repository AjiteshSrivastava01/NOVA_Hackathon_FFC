# Reference photos (few-shot examples)

One folder per `menu_id` from `src/menu.js`. Put up to **3** photos in each, and
**name the file with a caption**. The model reads the filename as the label:

```
vision-refs/burger/standard - lettuce and tomato.jpg
vision-refs/burger/no lettuce.jpg
vision-refs/burger/no tomato.jpg
vision-refs/fries/regular fries.jpg
```

Tips:
- Use the same plates, lighting and camera angle as the real camera station.
- Include the confusing cases: lettuce vs. no lettuce, tomato vs. no tomato, soda vs. water.
- Resize to about 512px wide and keep each file under 100 KB. Every reference is sent with every request.
- Only references for dishes on the selected ticket are sent.

This folder contains a pokemon go great league web application.

The application is supposed to do the following.

Take in a CSV with the following format through text input:

Ancestor?,Scan date,Nr,Name,Temp Evo,Gender,Nickname,Level,possibleLevels,CP,HP,Dust cost,min IV%,ØIV%,max IV%,ØATT IV,ØDEF IV,ØHP IV,Unique?,Fast move,Fast move (ID),Special move,Special move (ID),Special move 2,Special move 2 (ID),DPS,GL Evo,GL Rank (min),GL Rank (max),Box,Custom1,Custom2,Saved,Egg,Lucky?,Favorite,BuddyBoosted,Form,ShadowForm,MultiForm?,Dynamax,Height (cm),Weight (g),Height Tag,Catch Date,Catch Level
0,3/31/26 20:57:15,162,Furret,-,♀,44☪❁87D,37.5,37.5,1497,159,9000,44.4,44.4,44.4,0.0,12.0,8.0,1,Sucker Punch,98,Trailblaze,301, - , - ,15.8,Furret,134,134,Favorite,,,0,0,0,1,0,2042,1,0, - ,194,43310,0,2018-08-09,?
0,3/31/26 20:57:24,211,Qwilfish,-,♂,Qwi♂73,26.5,26.5,1493,115,4000,73.3,73.3,73.3,13.0,15.0,5.0,1, - , - , - , - , - , - ,0.0,Qwilfish,2003,2003,Favorite,,,0,0,0,1,0,1974,7,0,?,?,?,0,?,?

assume the csv headers can be taken in any order. functionality needs to search for the headers.

after the input. the great league calculator finds the max pvp power levels based on the IV inputs and the pokemon's base stats.

the application considers further evolutions of pokemon as well if it would stay under the cap.

the application considers the stats of the imported pokemon, not the level 1 stats of the pokemon imported.

the pokemon are sorted by meta sheet csv, the top meta pokemon being the most important

there needs to be a filter so that 98% or greater pokemon can only be shown